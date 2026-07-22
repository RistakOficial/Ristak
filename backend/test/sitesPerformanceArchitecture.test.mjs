import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import { listSites } from '../src/services/sitesService.js'

const frontendSourceUrl = new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url)
const frontendRouteSourceUrl = new URL('../../frontend/src/pages/Sites/SitesRoute.tsx', import.meta.url)
const calendarSettingsSourceUrl = new URL('../../frontend/src/pages/Settings/CalendarsConfiguration.tsx', import.meta.url)
const domainsSettingsSourceUrl = new URL('../../frontend/src/pages/Settings/Domains.tsx', import.meta.url)
const frontendServiceSourceUrl = new URL('../../frontend/src/services/sitesService.ts', import.meta.url)
const backendSourceUrl = new URL('../src/services/sitesService.js', import.meta.url)
const backendControllerSourceUrl = new URL('../src/controllers/sitesController.js', import.meta.url)
const sqliteScopedPageMigrationUrl = new URL('../migrations/versioned/091_sites_library_scoped_pages.sqlite.sql', import.meta.url)
const postgresLandingPageMigrationUrl = new URL('../migrations/versioned/091a_sites_landing_library_page.postgres.sql', import.meta.url)
const postgresFormPageMigrationUrl = new URL('../migrations/versioned/091b_sites_form_library_page.postgres.sql', import.meta.url)
const sqliteLibraryQueryMigrationUrl = new URL('../migrations/versioned/093_sites_library_folder_queries.sqlite.sql', import.meta.url)
const postgresLibrarySearchMigrationUrl = new URL('../migrations/versioned/093a_sites_library_search.postgres.sql', import.meta.url)
const SITE_LIBRARY_ROOT_ID = '__root__'

test('Sites abre con summaries paginados y un solo cargador de detalle compartido', async () => {
  const [source, routeSource, frontendServiceSource, backendSource, controllerSource] = await Promise.all([
    readFile(frontendSourceUrl, 'utf8'),
    readFile(frontendRouteSourceUrl, 'utf8'),
    readFile(frontendServiceSourceUrl, 'utf8'),
    readFile(backendSourceUrl, 'utf8'),
    readFile(backendControllerSourceUrl, 'utf8')
  ])

  assert.doesNotMatch(source, /hydrateSitesForBuilder/)
  assert.match(source, /const \[libraryPages, setLibraryPages\]/)
  assert.match(source, /libraryPageRequestRef/)
  assert.match(source, /sitesService\.listSitesPage\(\{[\s\S]{0,180}limit: SITES_LIBRARY_PAGE_SIZE[\s\S]{0,180}kind/)
  assert.match(source, /section !== 'landings' && section !== 'forms'[\s\S]{0,260}loadLibraryPage\(section\)/)
  assert.match(source, /getSitesLibraryQueryKey/)
  assert.match(source, /libraryPagesRef\.current\[kind\]\.queryKey !== queryKey/)
  assert.match(source, /folderCounts=\{activeLibraryPage\?\.facets\.folderCounts/)
  assert.match(source, /const loadSiteDetail = useCallback\(\(siteId: string/)
  assert.equal((source.match(/sitesService\.getSite\(siteId/g) || []).length, 1)
  assert.match(source, /const \[formCatalog, setFormCatalog\]/)
  assert.match(source, /listAllSiteSelectors\(\{ kind: 'forms' \}\)/)
  assert.match(source, /collectLinkedFormIdsFromBlocks/)
  assert.match(source, /hydratedFormDetails\[formId\]\?\.blocks/)
  assert.match(source, /includeSubmissions: true,[\s\S]{0,80}submissionLimit: 200/)
  const libraryPreviewStart = source.indexOf('const LibrarySitePreview')
  const libraryPreviewEnd = source.indexOf('\nconst SitesLibraryPanel', libraryPreviewStart)
  const libraryPreviewSource = source.slice(libraryPreviewStart, libraryPreviewEnd)
  assert.match(libraryPreviewSource, /sitesService\.getPreviewHtml\(site\.id, firstPageId, \{[\s\S]{0,120}test: true,[\s\S]{0,120}signal: controller\.signal/)
  assert.match(libraryPreviewSource, /controller\.abort\(\)/)
  assert.match(libraryPreviewSource, /new IntersectionObserver\(/)
  assert.match(libraryPreviewSource, /rootMargin: '240px 0px'/)
  assert.match(libraryPreviewSource, /srcDoc=\{previewHtml\}/)
  assert.match(libraryPreviewSource, /sandbox=""/)
  assert.doesNotMatch(libraryPreviewSource, /getLibraryPreviewBlocks|CanvasPreviewBlock|site\.blocks/)
  assert.match(frontendServiceSource, /includeTrackingStats.*\? '1' : '0'/s)
  const previewServiceStart = frontendServiceSource.indexOf('async getPreviewHtml')
  const previewServiceEnd = frontendServiceSource.indexOf('\n  createPreviewSession', previewServiceStart)
  const previewServiceSource = frontendServiceSource.slice(previewServiceStart, previewServiceEnd)
  assert.match(previewServiceSource, /signal\?: AbortSignal/)
  assert.match(previewServiceSource, /signal: options\.signal/)
  assert.match(backendSource, /includeTrackingStats = false/)
  assert.match(backendSource, /if \(includeTrackingStats\) \{[\s\S]{0,120}getSiteTrackingStats/)
  assert.match(controllerSource, /includeTrackingStats:[\s\S]{0,120}!== '0'/)
  assert.match(routeSource, /const LazySitesWorkspace = React\.lazy/)
  assert.match(routeSource, /<React\.Suspense fallback=\{<Loading page="sites" message="Abriendo Sitios\.\.\." \/>\}>/)
  assert.doesNotMatch(routeSource, /SitesRouteShell|PageContainer|PageHeader|TabList|prewarmSitesRoute/)
  assert.doesNotMatch(routeSource, /sitesService\.|warmup\.critical|Promise\.all\(|useEffect|useLocation|useNavigate/)
  assert.doesNotMatch(routeSource, /limit: 120|folderId: '__root__'|includeFacets: true/)
})

test('listSites agrega métricas por lote y no conserva subqueries correlacionadas por site', async () => {
  const [source, controllerSource] = await Promise.all([
    readFile(backendSourceUrl, 'utf8'),
    readFile(backendControllerSourceUrl, 'utf8')
  ])

  assert.match(source, /WITH paged_sites AS/)
  assert.match(source, /scoped_submissions AS/)
  assert.match(source, /tracking_metrics AS/)
  assert.match(source, /SITE_LIBRARY_PAGE_VIEWS = new Set\(\['landing_library', 'form_library'\]\)/)
  assert.match(source, /ORDER BY \$\{cursorTimestampExpression\} DESC, s\.id DESC[\s\S]{0,80}LIMIT \?/)
  assert.doesNotMatch(source, /SELECT COUNT\(\*\)[\s\S]{0,100}WHERE \(ts\.site_id = s\.id OR ts\.form_site_id = s\.id\)/)
  assert.match(controllerSource, /view === 'landing_library' \|\|[\s\S]{0,80}view === 'form_library'/)
})

test('el embudo de formularios agrega respuestas en SQL y el alcance v2 exige rango', async () => {
  const source = await readFile(backendSourceUrl, 'utf8')
  const funnelStart = source.indexOf('const SITE_ANALYTICS_FIELD_AGGREGATE_CHUNK_SIZE')
  const funnelEnd = source.indexOf('\nasync function getSitesTrackingBreakdown', funnelStart)
  const funnelSource = source.slice(funnelStart, funnelEnd)

  assert.match(funnelSource, /json_each\(/)
  assert.match(funnelSource, /jsonb_each\(/)
  assert.match(funnelSource, /COUNT\(DISTINCT CASE[\s\S]*answered_count/)
  assert.doesNotMatch(funnelSource, /parseJson\(row\.response_json/)
  assert.doesNotMatch(funnelSource, /submissions\.reduce/)
  assert.match(source, /!legacyMode && hasV2Request && \(!requestedDateFrom \|\| !requestedDateTo\)/)
  assert.match(source, /legacyMode \? 500 : 101/)
})

test('view=library conserva el arreglo legacy y vistas desconocidas no rompen consumidores históricos', async () => {
  const legacy = await listSites({ limit: 2, view: 'library' })
  const unknown = await listSites({ limit: 2, view: 'future_unknown_view' })

  assert.ok(Array.isArray(legacy))
  assert.ok(Array.isArray(unknown))
})

test('los selectores de Configuración consultan páginas server-side y no recorren catálogos completos al montar', async () => {
  const [calendarSource, domainsSource, serviceSource, backendSource] = await Promise.all([
    readFile(calendarSettingsSourceUrl, 'utf8'),
    readFile(domainsSettingsSourceUrl, 'utf8'),
    readFile(frontendServiceSourceUrl, 'utf8'),
    readFile(backendSourceUrl, 'utf8')
  ])

  assert.doesNotMatch(calendarSource, /listAllSiteSelectors/)
  assert.match(calendarSource, /listSiteSelectorsPage\(\{[\s\S]{0,180}kind: 'forms'/)
  assert.match(calendarSource, /limit: 30/)
  assert.match(calendarSource, /selectedIds/)
  assert.match(calendarSource, /onSearchChange=\{handleCalendarFormsSearch\}/)
  assert.match(calendarSource, /onLoadMore=/)
  assert.doesNotMatch(calendarSource, /Promise\.all\(rawForms\.map/)
  assert.doesNotMatch(domainsSource, /listAllSiteSelectors/)
  assert.match(domainsSource, /listSiteSelectorsPage\(\{[\s\S]{0,180}kind: 'domain'/)
  assert.match(domainsSource, /searchPlaceholder="Buscar página o formulario…"/)
  assert.match(serviceSource, /while \(hasMore && items\.length < maxItems\)/)
  assert.match(serviceSource, /truncated: hasMore && items\.length >= maxItems/)
  assert.match(serviceSource, /\/sites\/selectors\?/)
  assert.match(serviceSource, /Math\.min\(50/)
  assert.match(serviceSource, /kind\?: 'landings' \| 'forms'/)
  assert.match(serviceSource, /'landing_library' : 'form_library'/)
  assert.match(backendSource, /Este contrato existe para combos de configuración/)
  assert.match(backendSource, /normalizedView === 'domain_selector'[\s\S]{0,180}normalizedView === 'form_selector'/)
})

test('el selector integrado de dominios pagina únicamente landings activas', async () => {
  const source = await readFile(backendSourceUrl, 'utf8')
  const frontend = await readFile(frontendServiceSourceUrl, 'utf8')
  const sitesWorkspace = await readFile(frontendSourceUrl, 'utf8')

  assert.match(source, /view === 'landing_selector'[\s\S]*?s\.site_type = 'landing_page' AND s\.status != 'archived'/)
  assert.match(source, /normalizedView === 'landing_selector'/)
  assert.match(frontend, /listSiteSelectorsPage[\s\S]*?kind: options\.kind/)
  assert.match(source, /landings: 'landing_selector'/)

  const selectorLoader = frontend.slice(
    frontend.indexOf('listSiteSelectorsPage(options:'),
    frontend.indexOf('listAnalyticsSiteOptionsPage(options:')
  )
  assert.match(selectorLoader, /withRequestTimeout\(\{/)
  assert.match(selectorLoader, /timeoutMs: SITES_VIEW_REQUEST_TIMEOUT_MS/)
  assert.match(selectorLoader, /signal: options\.signal/)
  assert.match(selectorLoader, /apiClient\.get<SitesSelectorPage>[\s\S]{0,120}signal: requestSignal/)

  const integratedSelector = sitesWorkspace.slice(
    sitesWorkspace.indexOf('const loadDomainSelector = useCallback'),
    sitesWorkspace.indexOf('const ensureDomainSites = useCallback')
  )
  assert.match(sitesWorkspace, /const domainSitesAbortRef = useRef<AbortController \| null>\(null\)/)
  assert.match(integratedSelector, /signal: controller\.signal/)
  assert.match(integratedSelector, /controller\.signal\.aborted/)
  assert.match(sitesWorkspace, /domainSitesAbortRef\.current\?\.abort\(\)/)
})

test('analytics_selector pagina fuera de carpetas y respeta tipo, modo y videos disponibles', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const needle = `analytics-option-${suffix}`
  const ids = {
    nullUpdatedNewest: `${needle}-null-updated-newest`,
    websiteA: `${needle}-website-a`,
    websiteB: `${needle}-website-b`,
    funnel: `${needle}-funnel`,
    draft: `${needle}-draft`,
    form: `${needle}-form`,
    calendar: `${needle}-calendar`,
    uploadingVideo: `${needle}-uploading-video`,
    deletedVideo: `${needle}-deleted-video`,
    nullUpdatedOldest: `${needle}-null-updated-oldest`
  }
  const mediaIds = {
    ready: `${needle}-media-ready`,
    draft: `${needle}-media-draft`,
    uploading: `${needle}-media-uploading`,
    deleted: `${needle}-media-deleted`
  }

  const insertSite = async ({ id, siteType, status, theme, updatedAt, createdAt = updatedAt }) => {
    await db.run(`
      INSERT INTO public_sites (
        id, name, slug, site_type, status, title, description, theme_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
    `, [
      id,
      id,
      id,
      siteType,
      status,
      id,
      JSON.stringify(theme),
      createdAt,
      updatedAt
    ])
  }
  const insertMedia = async ({ id, siteId, status = 'ready', deletedAt = null }) => {
    await db.run(`
      INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, public_url,
        media_type, status, module, module_entity_id, is_public,
        created_at, updated_at, deleted_at
      ) VALUES (?, 'default', ?, ?, ?, 'video', ?, 'sites', ?, 1,
        '2099-10-01 12:00:00', '2099-10-01 12:00:00', ?)
    `, [id, `${id}.mp4`, `${id}.mp4`, `https://media.example.test/${id}.mp4`, status, siteId, deletedAt])
  }

  try {
    await insertSite({
      id: ids.nullUpdatedNewest,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website' },
      createdAt: '2099-10-10 12:00:00',
      updatedAt: null
    })
    await insertSite({
      id: ids.websiteA,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website', libraryFolderId: `${needle}-folder-a` },
      updatedAt: '2099-10-09 12:00:00'
    })
    await insertSite({
      id: ids.websiteB,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website', libraryFolderId: `${needle}-folder-b` },
      updatedAt: '2099-10-08 12:00:00'
    })
    await insertSite({
      id: ids.funnel,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'funnel', libraryFolderId: `${needle}-folder-a` },
      updatedAt: '2099-10-07 12:00:00'
    })
    await insertSite({
      id: ids.draft,
      siteType: 'landing_page',
      status: 'draft',
      theme: { pageMode: 'website', libraryFolderId: `${needle}-folder-a` },
      updatedAt: '2099-10-06 12:00:00'
    })
    await insertSite({
      id: ids.form,
      siteType: 'standard_form',
      status: 'published',
      theme: { librarySource: 'manual', libraryFolderId: `${needle}-form-folder` },
      updatedAt: '2099-10-05 12:00:00'
    })
    await insertSite({
      id: ids.calendar,
      siteType: 'interactive_form',
      status: 'published',
      theme: { librarySource: 'calendar' },
      updatedAt: '2099-10-04 12:00:00'
    })
    await insertSite({
      id: ids.uploadingVideo,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website' },
      updatedAt: '2099-10-03 12:00:00'
    })
    await insertSite({
      id: ids.deletedVideo,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website' },
      updatedAt: '2099-10-02 12:00:00'
    })
    await insertSite({
      id: ids.nullUpdatedOldest,
      siteType: 'landing_page',
      status: 'published',
      theme: { pageMode: 'website' },
      createdAt: '2099-10-01 11:00:00',
      updatedAt: null
    })

    await insertMedia({ id: mediaIds.ready, siteId: ids.websiteA })
    await insertMedia({ id: mediaIds.draft, siteId: ids.draft })
    await insertMedia({ id: mediaIds.uploading, siteId: ids.uploadingVideo, status: 'uploading' })
    await insertMedia({
      id: mediaIds.deleted,
      siteId: ids.deletedVideo,
      deletedAt: '2099-10-02 13:00:00'
    })

    const websiteIds = []
    let cursor = ''
    do {
      const page = await listSites({
        view: 'analytics_selector',
        siteType: 'sites',
        landingMode: 'website',
        search: needle,
        limit: 1,
        cursor
      })
      websiteIds.push(...page.items.map(site => site.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(websiteIds, [
      ids.nullUpdatedNewest,
      ids.websiteA,
      ids.websiteB,
      ids.uploadingVideo,
      ids.deletedVideo,
      ids.nullUpdatedOldest
    ])

    const scopedCursorPage = await listSites({
      view: 'analytics_selector',
      siteType: 'sites',
      landingMode: 'website',
      search: needle,
      limit: 1
    })
    const decodedScopedCursor = JSON.parse(
      Buffer.from(scopedCursorPage.nextCursor, 'base64url').toString('utf8')
    )
    assert.equal(decodedScopedCursor.v, 2)
    assert.equal(typeof decodedScopedCursor.scope, 'string')
    await assert.rejects(
      () => listSites({
        view: 'analytics_selector',
        siteType: 'sites',
        landingMode: 'funnel',
        search: needle,
        limit: 1,
        cursor: scopedCursorPage.nextCursor
      }),
      (error) => error?.status === 400 && error?.code === 'invalid_sites_cursor'
    )
    await assert.rejects(
      () => listSites({ view: 'analytics_selector', cursor: 'cursor-roto' }),
      (error) => error?.status === 400 && error?.code === 'invalid_sites_cursor'
    )

    const punctuationSearchPage = await listSites({
      view: 'analytics_selector',
      siteType: 'sites',
      landingMode: 'website',
      search: '%%%',
      limit: 1
    })
    assert.equal(punctuationSearchPage.items[0]?.id, ids.nullUpdatedNewest)

    const formPage = await listSites({
      view: 'analytics_selector',
      siteType: 'forms',
      search: needle,
      limit: 20
    })
    assert.deepEqual(formPage.items.map(site => site.id), [ids.form])

    const videoPage = await listSites({
      view: 'analytics_selector',
      siteType: 'videos',
      search: needle,
      limit: 20
    })
    assert.deepEqual(videoPage.items.map(site => site.id), [ids.websiteA])
  } finally {
    await db.run(
      `DELETE FROM media_assets WHERE id IN (${Object.values(mediaIds).map(() => '?').join(', ')})`,
      Object.values(mediaIds)
    ).catch(() => undefined)
    await db.run(
      `DELETE FROM public_sites WHERE id IN (${Object.values(ids).map(() => '?').join(', ')})`,
      Object.values(ids)
    ).catch(() => undefined)
  }
})

test('frontend y controller exponen analytics_selector sin reutilizar folderId', async () => {
  const [frontend, controller] = await Promise.all([
    readFile(frontendServiceSourceUrl, 'utf8'),
    readFile(backendControllerSourceUrl, 'utf8')
  ])
  const methodStart = frontend.indexOf('listAnalyticsSiteOptionsPage(options:')
  const methodEnd = frontend.indexOf('\n  async listAllSiteSelectors', methodStart)
  const methodSource = frontend.slice(methodStart, methodEnd)

  assert.ok(methodStart >= 0 && methodEnd > methodStart)
  assert.match(methodSource, /view: 'analytics_selector'/)
  assert.match(methodSource, /siteType: options\.siteType/)
  assert.match(methodSource, /options\.landingMode/)
  assert.match(methodSource, /options\.search/)
  assert.match(methodSource, /options\.cursor/)
  assert.doesNotMatch(methodSource, /folderId/)
  assert.match(controller, /view === 'analytics_selector'/)
  assert.match(controller, /siteType: req\.query\?\.siteType/)
  assert.match(controller, /landingMode: req\.query\?\.landingMode/)
})

test('Analíticas resuelve catálogos ligeros antes de lanzar un solo aggregate pesado', async () => {
  const source = await readFile(frontendSourceUrl, 'utf8')
  const summaryEffectStart = source.indexOf("if (section !== 'analytics') {", source.indexOf('const loadSiteVideos'))
  const summaryRequestStart = source.indexOf('sitesService.getAnalyticsSummary({', summaryEffectStart)
  const summaryPrelude = source.slice(summaryEffectStart, summaryRequestStart)

  assert.match(source, /defaultItems: PublicSite\[\]/)
  assert.match(source, /defaultScopeReadyKey: string/)
  assert.match(source, /sitesAnalyticsDefaultScopeReadyRef/)
  assert.match(source, /Promise\.allSettled\(\[pageRequest, defaultPageRequest\]\)/)
  assert.match(source, /const sitesAnalyticsEffectiveSearch = useMemo/)
  assert.match(source, /const analyticsSelectedSiteReady = !sitesAnalyticsSiteId/)
  assert.match(summaryPrelude, /catalogReady/)
  assert.match(summaryPrelude, /videoWindowReady/)
  assert.match(summaryPrelude, /!analyticsSelectedSiteReady/)
  assert.doesNotMatch(source, /section !== 'analytics'[\s\S]{0,180}loadLibraryPage/)
})

test('la biblioteca usa SWR acotado sin recalcular facets ni perder Cargar más', async () => {
  const source = await readFile(frontendSourceUrl, 'utf8')
  const loadStart = source.indexOf('const loadLibraryPage = useCallback')
  const loadEnd = source.indexOf('\n  const loadDomainSelector', loadStart)
  const loadSource = source.slice(loadStart, loadEnd)

  assert.match(source, /SITES_LIBRARY_CACHE_TTL_MS = 30_000/)
  assert.match(source, /SITES_LIBRARY_FACETS_TTL_MS = 300_000/)
  assert.match(source, /normalizeSitesSearchQuery[\s\S]{0,180}searchableCharacters >= 3/)
  assert.match(loadSource, /backgroundRefresh/)
  assert.match(loadSource, /append && libraryPagePromiseRef\.current\[kind\]/)
  assert.match(loadSource, /includeFacets: !append/)
  assert.match(loadSource, /currentPage\.facetsValidatedAt <= 0/)
  assert.match(loadSource, /validatedAt: append \? current\[kind\]\.validatedAt : Date\.now\(\)/)
  assert.match(loadSource, /facetsValidatedAt: page\.facets \? Date\.now\(\)/)
})

test('los cursores de Sites preservan microsegundos de PostgreSQL sin alterar updated_at', async () => {
  const source = await readFile(backendSourceUrl, 'utf8')

  assert.match(source, /cursorUpdatedAt = row\.cursor_updated_at \?\? row\.updated_at/)
  assert.match(source, /COALESCE\(\$\{alias\}\.updated_at, \$\{alias\}\.created_at, TIMESTAMP '1970-01-01 00:00:00'\)/)
  assert.match(source, /getSiteListCursorProjectionExpression[\s\S]{0,180}\(\$\{timestampExpression\}\)::text/)
  assert.match(source, /s\.updated_at,[\s\S]{0,100}AS cursor_updated_at/)
  assert.match(source, /\$\{cursorTimestampExpression\} < \?[\s\S]{0,120}\$\{cursorTimestampExpression\} = \?/)
  assert.match(source, /ORDER BY \$\{cursorTimestampExpression\} DESC, s\.id DESC/)
  assert.match(source, /ORDER BY \$\{getSiteListCursorSortExpression\('ps'\)\} DESC, ps\.id DESC/)
  assert.match(source, /mapSiteSummary\(row\)/)
})

test('la búsqueda de Sites exige tres letras o números antes de aplicar LIKE', async () => {
  const source = await readFile(backendSourceUrl, 'utf8')

  assert.match(source, /search\.match\(\/\[\\p\{L\}\\p\{N\}\]\/gu\)\?\.length/)
  assert.match(source, /searchableCharacters >= 3 \? search : ''/)
  assert.equal((source.match(/normalizeSiteLibrarySearch\(search\)/g) || []).length, 2)
})

test('las bibliotecas separadas tienen índices parciales compatibles con su cursor', async () => {
  const [sqliteSql, postgresLandingSql, postgresFormSql] = await Promise.all([
    readFile(sqliteScopedPageMigrationUrl, 'utf8'),
    readFile(postgresLandingPageMigrationUrl, 'utf8'),
    readFile(postgresFormPageMigrationUrl, 'utf8')
  ])

  assert.match(sqliteSql, /idx_public_sites_landing_library_page[\s\S]*WHERE site_type = 'landing_page'/)
  assert.match(sqliteSql, /idx_public_sites_form_library_page[\s\S]*WHERE site_type IN \('standard_form', 'interactive_form'\)/)
  assert.equal((postgresLandingSql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1)
  assert.equal((postgresFormSql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1)

  if (databaseDialect !== 'sqlite') return

  await db.exec(sqliteSql)
  const [landingPlan, formPlan] = await Promise.all([
    db.all(`
      EXPLAIN QUERY PLAN
      SELECT id FROM public_sites
      WHERE site_type = 'landing_page'
      ORDER BY updated_at DESC, id DESC
      LIMIT 20
    `),
    db.all(`
      EXPLAIN QUERY PLAN
      SELECT id FROM public_sites
      WHERE site_type IN ('standard_form', 'interactive_form')
        AND id != 'system-calendar-booking-form'
      ORDER BY updated_at DESC, id DESC
      LIMIT 20
    `)
  ])
  assert.match(landingPlan.map(row => row.detail).join(' '), /idx_public_sites_landing_library_page/)
  assert.match(formPlan.map(row => row.detail).join(' '), /idx_public_sites_form_library_page/)
})

test('la biblioteca filtra y pagina en servidor, busca fuera de la carpeta y devuelve facets globales', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const folderId = `library-folder-${suffix}`
  const otherFolderId = `library-other-${suffix}`
  const needle = `needle-${suffix}`
  const landingIds = Array.from({ length: 6 }, (_, index) => `library-landing-${suffix}-${index}`)
  const calendarFormId = `library-calendar-${suffix}`

  try {
    for (const [index, id] of landingIds.entries()) {
      const assignedFolder = index < 5 ? folderId : SITE_LIBRARY_ROOT_ID
      const theme = assignedFolder === SITE_LIBRARY_ROOT_ID ? {} : { libraryFolderId: assignedFolder }
      const name = index === 4 ? `Landing ${needle}` : `Landing servidor ${suffix} ${index}`
      await db.run(`
        INSERT INTO public_sites (
          id, name, slug, site_type, status, title, description, theme_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'landing_page', 'draft', ?, '', ?, ?, ?)
      `, [
        id,
        name,
        `library-${suffix}-${index}`,
        name,
        JSON.stringify(theme),
        `2097-09-${String(index + 1).padStart(2, '0')} 12:00:00`,
        `2097-09-${String(index + 1).padStart(2, '0')} 12:00:00`
      ])
    }
    await db.run(`
      INSERT INTO public_sites (
        id, name, slug, site_type, status, title, description, theme_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'standard_form', 'draft', ?, '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      calendarFormId,
      `Calendar oculto ${needle}`,
      `calendar-hidden-${suffix}`,
      `Calendar oculto ${needle}`,
      JSON.stringify({ librarySource: 'calendar' })
    ])

    const firstPage = await listSites({
      view: 'landing_library',
      folderId,
      limit: 2,
      includeFacets: true
    })
    assert.equal(firstPage.items.length, 2)
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.facets.folderCounts[folderId], 5)
    assert.ok(firstPage.facets.total >= 6)
    assert.ok(firstPage.items.every(site => site.theme.libraryFolderId === folderId))

    const collectedIds = [...firstPage.items.map(site => site.id)]
    let cursor = firstPage.nextCursor
    while (cursor) {
      const page = await listSites({
        view: 'landing_library',
        folderId,
        limit: 2,
        cursor,
        includeFacets: false
      })
      assert.equal(page.facets, null)
      collectedIds.push(...page.items.map(site => site.id))
      cursor = page.nextCursor
    }
    assert.deepEqual(new Set(collectedIds), new Set(landingIds.slice(0, 5)))

    const searchPage = await listSites({
      view: 'landing_library',
      folderId: otherFolderId,
      search: needle,
      limit: 20,
      includeFacets: true
    })
    assert.deepEqual(searchPage.items.map(site => site.id), [landingIds[4]])
    assert.equal(searchPage.facets.folderCounts[folderId], 5)

    const hiddenCalendar = await listSites({
      view: 'form_library',
      search: needle,
      limit: 20,
      includeFacets: true
    })
    assert.equal(hiddenCalendar.items.some(site => site.id === calendarFormId), false)
    assert.equal(hiddenCalendar.facets.folderCounts['system-calendar-forms'], undefined)
  } finally {
    for (const id of [...landingIds, calendarFormId]) {
      await db.run('DELETE FROM public_sites WHERE id = ?', [id]).catch(() => undefined)
    }
  }
})

test('los índices 093 cubren carpeta/cursor en SQLite y búsqueda trigram en PostgreSQL', async () => {
  const [sqliteSql, postgresSearchSql] = await Promise.all([
    readFile(sqliteLibraryQueryMigrationUrl, 'utf8'),
    readFile(postgresLibrarySearchMigrationUrl, 'utf8')
  ])

  assert.match(sqliteSql, /idx_public_sites_landing_library_folder_page/)
  assert.match(sqliteSql, /idx_public_sites_form_library_folder_page/)
  assert.match(sqliteSql, /__root__/)
  assert.match(postgresSearchSql, /CREATE INDEX CONCURRENTLY/)
  assert.match(postgresSearchSql, /gin_trgm_ops/)

  if (databaseDialect !== 'sqlite') return
  await db.exec(sqliteSql)
  const plan = await db.all(`
    EXPLAIN QUERY PLAN
    SELECT id
    FROM public_sites
    WHERE site_type = 'landing_page'
      AND COALESCE(
        NULLIF(
          TRIM(CAST(COALESCE(
            json_extract(
              (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
              '$.libraryFolderId'
            ),
            ''
          ) AS TEXT)),
          ''
        ),
        '__root__'
      ) = '__root__'
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  `)
  assert.match(JSON.stringify(plan), /idx_public_sites_landing_library_folder_page/)
})

test('landing_library y form_library recorren entidades intercaladas sin contaminar ni truncar', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const pageSize = 19
  const entityCount = 65
  const landingIds = Array.from({ length: entityCount }, (_, index) => `perf-landing-view-${suffix}-${String(index).padStart(3, '0')}`)
  const formIds = Array.from({ length: entityCount }, (_, index) => `perf-form-view-${suffix}-${String(index).padStart(3, '0')}`)
  const landingMetricId = landingIds[0]
  const formMetricId = formIds[0]
  const submissionIds = [`perf-landing-sub-${suffix}`, `perf-form-sub-${suffix}`]
  const sessionIds = [randomUUID(), randomUUID()]

  const timestampForSequence = (sequence) => {
    const minuteOfDay = (23 * 60 + 59) - sequence
    const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, '0')
    const minutes = String(minuteOfDay % 60).padStart(2, '0')
    return `2097-11-30 ${hours}:${minutes}:00`
  }

  const collectView = async (view) => {
    const items = []
    const seenCursors = new Set()
    let cursor = ''
    let pageCount = 0

    while (pageCount < 1000) {
      const page = await listSites({ limit: pageSize, cursor, view })
      assert.ok(Array.isArray(page.items), `${view} debe conservar el contrato paginado`)
      assert.equal(page.limit, pageSize)
      items.push(...page.items)
      pageCount += 1

      if (!page.hasMore) return { items, pageCount }
      assert.ok(page.nextCursor, `${view} debe entregar cursor cuando hay más registros`)
      assert.equal(seenCursors.has(page.nextCursor), false, `${view} no debe repetir cursores`)
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }

    assert.fail(`${view} no terminó su recorrido paginado`)
  }

  try {
    for (let index = 0; index < entityCount; index += 1) {
      const landingTimestamp = timestampForSequence(index * 2)
      const formTimestamp = timestampForSequence(index * 2 + 1)
      await db.run(`
        INSERT INTO public_sites (
          id, name, slug, site_type, status, title, description, theme_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'landing_page', 'draft', ?, '', ?, ?, ?)
      `, [
        landingIds[index],
        `Landing vista ${index}`,
        `landing-view-${suffix}-${index}`,
        `Landing vista ${index}`,
        JSON.stringify({ libraryFolderId: 'landing-scale-test' }),
        landingTimestamp,
        landingTimestamp
      ])
      await db.run(`
        INSERT INTO public_sites (
          id, name, slug, site_type, status, title, description, theme_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, '', ?, ?, ?)
      `, [
        formIds[index],
        `Formulario vista ${index}`,
        `form-view-${suffix}-${index}`,
        index % 2 === 0 ? 'standard_form' : 'interactive_form',
        `Formulario vista ${index}`,
        JSON.stringify({ libraryFolderId: 'form-scale-test', librarySource: 'manual' }),
        formTimestamp,
        formTimestamp
      ])
    }

    await db.run(`
      INSERT INTO public_site_submissions (id, site_id, response_json, created_at)
      VALUES (?, ?, '{}', '2097-11-30 23:59:30')
    `, [submissionIds[0], landingMetricId])
    await db.run(`
      INSERT INTO public_site_submissions (id, site_id, form_site_id, response_json, created_at)
      VALUES (?, ?, ?, '{}', '2097-11-30 23:58:30')
    `, [submissionIds[1], formMetricId, formMetricId])
    await db.run(`
      INSERT INTO sessions (id, site_id, visitor_id, session_id, event_name, created_at)
      VALUES (?, ?, ?, ?, 'native_site_view', '2097-11-30 23:59:30')
    `, [sessionIds[0], landingMetricId, `landing-visitor-${suffix}`, `landing-session-${suffix}`])
    await db.run(`
      INSERT INTO sessions (id, form_site_id, visitor_id, session_id, event_name, created_at)
      VALUES (?, ?, ?, ?, 'native_site_view', '2097-11-30 23:58:30')
    `, [sessionIds[1], formMetricId, `form-visitor-${suffix}`, `form-session-${suffix}`])

    const [landingCollection, formCollection] = await Promise.all([
      collectView('landing_library'),
      collectView('form_library')
    ])

    assert.ok(landingCollection.pageCount >= Math.ceil(entityCount / pageSize))
    assert.ok(formCollection.pageCount >= Math.ceil(entityCount / pageSize))
    assert.ok(landingCollection.items.every(site => site.siteType === 'landing_page'))
    assert.ok(formCollection.items.every(site => site.siteType === 'standard_form' || site.siteType === 'interactive_form'))
    assert.equal(formCollection.items.some(site => site.id === 'system-calendar-booking-form'), false)

    const ownLandings = landingCollection.items.filter(site => site.id.startsWith(`perf-landing-view-${suffix}-`))
    const ownForms = formCollection.items.filter(site => site.id.startsWith(`perf-form-view-${suffix}-`))
    assert.equal(ownLandings.length, entityCount)
    assert.equal(ownForms.length, entityCount)
    assert.deepEqual(new Set(ownLandings.map(site => site.id)), new Set(landingIds))
    assert.deepEqual(new Set(ownForms.map(site => site.id)), new Set(formIds))
    assert.equal(landingCollection.items.some(site => formIds.includes(site.id)), false)
    assert.equal(formCollection.items.some(site => landingIds.includes(site.id)), false)

    const landingMetric = ownLandings.find(site => site.id === landingMetricId)
    const formMetric = ownForms.find(site => site.id === formMetricId)
    assert.equal(landingMetric?.submissionsCount, 1)
    assert.equal(landingMetric?.trackingStats.views, 1)
    assert.equal(formMetric?.submissionsCount, 1)
    assert.equal(formMetric?.trackingStats.views, 1)
  } finally {
    await db.run('DELETE FROM sessions WHERE id IN (?, ?)', sessionIds).catch(() => undefined)
    await db.run('DELETE FROM public_site_submissions WHERE id IN (?, ?)', submissionIds).catch(() => undefined)
    for (const id of [...landingIds, ...formIds]) {
      await db.run('DELETE FROM public_sites WHERE id = ?', [id]).catch(() => undefined)
    }
  }
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
  const trackingRowIds = [randomUUID(), randomUUID()]
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
      [trackingRowIds[0], firstId, `visitor-${suffix}`, `session-${suffix}`]
    )
    await db.run(
      `INSERT INTO sessions (id, site_id, visitor_id, session_id, event_name, submission_id, created_at)
       VALUES (?, ?, ?, ?, 'native_site_conversion', ?, '2099-12-31 12:06:00')`,
      [trackingRowIds[1], firstId, `visitor-${suffix}`, `session-${suffix}`, `perf-submission-${suffix}`]
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
    await db.run('DELETE FROM sessions WHERE id IN (?, ?)', trackingRowIds).catch(() => undefined)
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
