import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import { listSites } from '../src/services/sitesService.js'

const frontendSourceUrl = new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url)
const calendarSettingsSourceUrl = new URL('../../frontend/src/pages/Settings/CalendarsConfiguration.tsx', import.meta.url)
const domainsSettingsSourceUrl = new URL('../../frontend/src/pages/Settings/Domains.tsx', import.meta.url)
const frontendServiceSourceUrl = new URL('../../frontend/src/services/sitesService.ts', import.meta.url)
const backendSourceUrl = new URL('../src/services/sitesService.js', import.meta.url)

test('Sites abre con summaries paginados y un solo cargador de detalle compartido', async () => {
  const source = await readFile(frontendSourceUrl, 'utf8')

  assert.doesNotMatch(source, /hydrateSitesForBuilder/)
  assert.match(source, /sitesService\.listSitesPage\(\{ limit: SITES_LIBRARY_PAGE_SIZE \}\)/)
  assert.match(source, /const loadSiteDetail = useCallback\(\(siteId: string\)/)
  assert.equal((source.match(/sitesService\.getSite\(siteId\)/g) || []).length, 1)
  assert.match(source, /const \[formCatalog, setFormCatalog\]/)
  assert.match(source, /listAllSiteSelectors\(\{ kind: 'forms' \}\)/)
  assert.match(source, /collectLinkedFormIdsFromBlocks/)
  assert.match(source, /hydratedFormDetails\[formId\]\?\.blocks/)
  assert.match(source, /includeSubmissions: true,[\s\S]{0,80}submissionLimit: 200/)
  assert.match(source, /site\.summary[\s\S]{0,200}librarySummaryPreview/)
})

test('listSites agrega métricas por lote y no conserva subqueries correlacionadas por site', async () => {
  const source = await readFile(backendSourceUrl, 'utf8')

  assert.match(source, /WITH paged_sites AS/)
  assert.match(source, /scoped_submissions AS/)
  assert.match(source, /tracking_metrics AS/)
  assert.match(source, /ORDER BY s\.updated_at DESC, s\.id DESC[\s\S]{0,80}LIMIT \?/)
  assert.doesNotMatch(source, /SELECT COUNT\(\*\)[\s\S]{0,100}WHERE \(ts\.site_id = s\.id OR ts\.form_site_id = s\.id\)/)
})

test('los selectores de Configuración recorren summaries ligeros sin N+1 ni límite silencioso de 200', async () => {
  const [calendarSource, domainsSource, serviceSource, backendSource] = await Promise.all([
    readFile(calendarSettingsSourceUrl, 'utf8'),
    readFile(domainsSettingsSourceUrl, 'utf8'),
    readFile(frontendServiceSourceUrl, 'utf8'),
    readFile(backendSourceUrl, 'utf8')
  ])

  assert.match(calendarSource, /listAllSiteSelectors\(\{ kind: 'forms' \}\)/)
  assert.doesNotMatch(calendarSource, /Promise\.all\(rawForms\.map/)
  assert.match(domainsSource, /listAllSiteSelectors\(\{ kind: 'domain' \}\)/)
  assert.match(serviceSource, /while \(hasMore && items\.length < maxItems\)/)
  assert.match(serviceSource, /truncated: hasMore && items\.length >= maxItems/)
  assert.match(backendSource, /Este contrato existe para combos de configuración/)
  assert.match(backendSource, /view === 'domain_selector' \|\| view === 'form_selector'/)
})

test('el catálogo ligero de formularios recorre más de 120 registros sin perder opciones', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const ids = Array.from({ length: 135 }, (_, index) => `perf-form-catalog-${suffix}-${String(index).padStart(3, '0')}`)

  try {
    for (const [index, id] of ids.entries()) {
      const timestamp = `2098-08-${String((index % 28) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00`
      await db.run(`
        INSERT INTO public_sites (
          id, name, slug, site_type, status, title, description, theme_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'standard_form', 'draft', ?, '', ?, ?, ?)
      `, [
        id,
        `Formulario catálogo ${index}`,
        `form-catalog-${suffix}-${index}`,
        `Formulario catálogo ${index}`,
        JSON.stringify({ librarySource: 'site_embed', libraryFolderId: 'catalog-test' }),
        timestamp,
        timestamp
      ])
    }

    const collected = []
    let cursor = ''
    let hasMore = true
    let pageCount = 0
    while (hasMore && pageCount < 20) {
      const page = await listSites({
        limit: 50,
        cursor,
        paginated: true,
        view: 'form_selector'
      })
      collected.push(...page.items)
      cursor = page.nextCursor
      hasMore = page.hasMore
      pageCount += 1
    }

    const ownForms = collected.filter(site => site.id.startsWith(`perf-form-catalog-${suffix}-`))
    assert.equal(ownForms.length, ids.length)
    assert.deepEqual(new Set(ownForms.map(site => site.id)), new Set(ids))
    assert.ok(pageCount >= 3)
    assert.ok(ownForms.every(site => site.summary === true))
    assert.ok(ownForms.every(site => !site.blocks || site.blocks.length === 0))
  } finally {
    for (const id of ids) {
      await db.run('DELETE FROM public_sites WHERE id = ?', [id]).catch(() => undefined)
    }
  }
})

test('listSites pagina por cursor, limita el payload y conserva métricas exactas', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const ids = Array.from({ length: 7 }, (_, index) => `perf-site-${suffix}-${index}`)
  const firstId = ids[0]

  try {
    for (const [index, id] of ids.entries()) {
      const timestamp = `2099-12-${String(31 - index).padStart(2, '0')} 12:00:00`
      await db.run(`
        INSERT INTO public_sites (
          id, name, slug, site_type, status, title, description, theme_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'landing_page', 'draft', ?, '', ?, ?, ?)
      `, [
        id,
        `Performance ${index}`,
        `performance-${suffix}-${index}`,
        `Performance ${index}`,
        JSON.stringify({
          accentColor: '#123456',
          libraryFolderId: 'perf-folder',
          pages: [{ id: 'page-1', title: 'Inicio', sortOrder: 0 }],
          importedHtmlDocument: 'x'.repeat(20_000)
        }),
        timestamp,
        timestamp
      ])
    }

    await db.run(
      `INSERT INTO public_site_submissions (id, site_id, response_json, created_at)
       VALUES (?, ?, '{}', '2099-12-31 12:05:00')`,
      [`perf-submission-${suffix}`, firstId]
    )
    await db.run(
      `INSERT INTO sessions (id, site_id, visitor_id, session_id, event_name, submission_id, created_at)
       VALUES (?, ?, ?, ?, 'native_site_view', NULL, '2099-12-31 12:05:00')`,
      [`perf-session-view-${suffix}`, firstId, `visitor-${suffix}`, `session-${suffix}`]
    )
    await db.run(
      `INSERT INTO sessions (id, site_id, visitor_id, session_id, event_name, submission_id, created_at)
       VALUES (?, ?, ?, ?, 'native_site_conversion', ?, '2099-12-31 12:06:00')`,
      [`perf-session-conversion-${suffix}`, firstId, `visitor-${suffix}`, `session-${suffix}`, `perf-submission-${suffix}`]
    )

    const firstPage = await listSites({ limit: 3, paginated: true })
    assert.equal(firstPage.items.length, 3)
    assert.equal(firstPage.hasMore, true)
    assert.ok(firstPage.nextCursor)
    assert.deepEqual(firstPage.items.map(site => site.id), ids.slice(0, 3))
    assert.equal(firstPage.items[0].summary, true)
    assert.equal(firstPage.items[0].theme.libraryFolderId, 'perf-folder')
    assert.equal(Array.isArray(firstPage.items[0].theme.pages), true)
    assert.equal(firstPage.items[0].theme.importedHtmlDocument, undefined)
    assert.equal(firstPage.items[0].submissionsCount, 1)
    assert.equal(firstPage.items[0].trackingStats.views, 1)
    assert.equal(firstPage.items[0].trackingStats.visitors, 1)
    assert.equal(firstPage.items[0].trackingStats.sessions, 1)
    assert.equal(firstPage.items[0].trackingStats.conversions, 1)

    const secondPage = await listSites({ limit: 3, cursor: firstPage.nextCursor, paginated: true })
    assert.deepEqual(secondPage.items.map(site => site.id), ids.slice(3, 6))
    assert.equal(secondPage.items.some(site => firstPage.items.some(first => first.id === site.id)), false)
  } finally {
    await db.run('DELETE FROM sessions WHERE id IN (?, ?)', [
      `perf-session-view-${suffix}`,
      `perf-session-conversion-${suffix}`
    ]).catch(() => undefined)
    await db.run('DELETE FROM public_site_submissions WHERE id = ?', [`perf-submission-${suffix}`]).catch(() => undefined)
    for (const id of ids) {
      await db.run('DELETE FROM public_sites WHERE id = ?', [id]).catch(() => undefined)
    }
  }
})

test('selector de formularios filtra archivados y omite agregados históricos', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const activeId = `perf-form-active-${suffix}`
  const archivedId = `perf-form-archived-${suffix}`

  try {
    await db.run(`
      INSERT INTO public_sites (
        id, name, slug, site_type, status, title, description, theme_json,
        created_at, updated_at
      ) VALUES (?, 'Formulario activo', ?, 'standard_form', 'published', 'Formulario activo', '', ?,
        '2099-12-31 13:00:00', '2099-12-31 13:00:00')
    `, [activeId, activeId, JSON.stringify({ paymentGate: { enabled: true }, librarySource: 'site_embed', ignored: 'x'.repeat(10_000) })])
    await db.run(`
      INSERT INTO public_sites (
        id, name, slug, site_type, status, title, description, theme_json,
        created_at, updated_at
      ) VALUES (?, 'Formulario archivado', ?, 'interactive_form', 'archived', 'Formulario archivado', '', '{}',
        '2099-12-31 12:59:00', '2099-12-31 12:59:00')
    `, [archivedId, archivedId])

    const page = await listSites({ limit: 20, paginated: true, view: 'form_selector' })
    const active = page.items.find(site => site.id === activeId)
    assert.ok(active)
    assert.equal(active.theme.paymentGate.enabled, true)
    assert.equal(active.theme.librarySource, 'site_embed')
    assert.equal(active.theme.ignored, undefined)
    assert.equal(active.submissionsCount, 0)
    assert.equal(active.trackingStats.views, 0)
    assert.equal(page.items.some(site => site.id === archivedId), false)
  } finally {
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [activeId, archivedId]).catch(() => undefined)
  }
})
