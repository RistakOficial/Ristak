import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  createSite,
  deleteSite,
  getSitesDomainSettings,
  renderPublicSiteHtml,
  resolvePublicSiteForHost,
  setSitesPublicDefaultRoute,
  updateSite
} from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error',
  defaultRoute: 'sites_public_default_route_site_id',
  defaultRoutePage: 'sites_public_default_route_page_id'
}

async function snapshotDomainConfig() {
  return {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error),
    defaultRoute: await getAppConfig(DOMAIN_KEYS.defaultRoute),
    defaultRoutePage: await getAppConfig(DOMAIN_KEYS.defaultRoutePage)
  }
}

async function restoreDomainConfig(config) {
  await Promise.all([
    setAppConfig(DOMAIN_KEYS.domain, config.domain),
    setAppConfig(DOMAIN_KEYS.verified, config.verified),
    setAppConfig(DOMAIN_KEYS.checkedAt, config.checkedAt),
    setAppConfig(DOMAIN_KEYS.error, config.error),
    setAppConfig(DOMAIN_KEYS.defaultRoute, config.defaultRoute),
    setAppConfig(DOMAIN_KEYS.defaultRoutePage, config.defaultRoutePage)
  ])
  await db.run("DELETE FROM public_site_domains WHERE domain IN ('example.test', 'alpha.example.test', 'beta.example.test')")
}

async function configureVerifiedPublicDomain(domain = 'example.test') {
  await Promise.all([
    setAppConfig(DOMAIN_KEYS.domain, domain),
    setAppConfig(DOMAIN_KEYS.verified, '1'),
    setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString()),
    setAppConfig(DOMAIN_KEYS.error, ''),
    setAppConfig(DOMAIN_KEYS.defaultRoute, ''),
    setAppConfig(DOMAIN_KEYS.defaultRoutePage, '')
  ])
}

test('public domain root uses the configured default site route', async () => {
  const previousConfig = await snapshotDomainConfig()
  const suffix = Date.now()
  let landing
  let form

  try {
    await configureVerifiedPublicDomain()

    landing = await createSite({
      name: 'Landing principal auto',
      slug: `landing-auto-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true
    })
    form = await createSite({
      name: 'Formulario principal elegido',
      slug: `form-default-${suffix}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })

    const automaticResolution = await resolvePublicSiteForHost('example.test', { path: '/' })
    assert.equal(automaticResolution.ok, true)
    assert.equal(automaticResolution.site.status, 'published')

    const settings = await setSitesPublicDefaultRoute(form.id)
    assert.equal(settings.defaultRoute.siteId, form.id)
    assert.equal(settings.defaultRoute.pageId, undefined)
    assert.equal(settings.defaultRoute.path, `/${form.slug}`)

    const rootResolution = await resolvePublicSiteForHost('example.test', { path: '/' })
    assert.equal(rootResolution.ok, true)
    assert.equal(rootResolution.site.id, form.id)

    const directResolution = await resolvePublicSiteForHost('example.test', { path: `/${landing.slug}` })
    assert.equal(directResolution.ok, true)
    assert.equal(directResolution.site.id, landing.id)
  } finally {
    if (form) await deleteSite(form.id).catch(() => undefined)
    if (landing) await deleteSite(landing.id).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('public domain root can use a configured default site page route', async () => {
  const previousConfig = await snapshotDomainConfig()
  const suffix = Date.now()
  let site

  try {
    await configureVerifiedPublicDomain()

    site = await createSite({
      name: 'Landing con paginas libres',
      slug: `site-default-page-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        pageMode: 'website',
        pages: [
          { id: 'page-home', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
          { id: 'page-special', title: 'Especial', slug: 'landing-especial', sortOrder: 1 }
        ]
      }
    })

    const settings = await setSitesPublicDefaultRoute(site.id, 'page-special')
    assert.equal(settings.defaultRoute.siteId, site.id)
    assert.equal(settings.defaultRoute.pageId, 'page-special')
    assert.equal(settings.defaultRoute.path, '/')
    assert.equal(settings.defaultRoute.pagePath, '/landing-especial')

    const rootResolution = await resolvePublicSiteForHost('example.test', { path: '/' })
    assert.equal(rootResolution.ok, true)
    assert.equal(rootResolution.site.id, site.id)
    assert.equal(rootResolution.pageId, 'page-special')

    const pageResolution = await resolvePublicSiteForHost('example.test', { path: '/landing-especial' })
    assert.equal(pageResolution.ok, true)
    assert.equal(pageResolution.site.id, site.id)
    assert.equal(pageResolution.pageId, 'page-special')

    const legacySiteResolution = await resolvePublicSiteForHost('example.test', { path: `/${site.slug}` })
    assert.equal(legacySiteResolution.ok, true)
    assert.equal(legacySiteResolution.site.id, site.id)
    assert.equal(legacySiteResolution.pageId, '')
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('imported HTML pages resolve clean public routes and can be domain root', async () => {
  const previousConfig = await snapshotDomainConfig()
  const suffix = Date.now()
  let site

  try {
    await configureVerifiedPublicDomain()

    const created = await createImportedSiteFromHtml({
      name: `HTML importado con rutas ${suffix}`,
      filename: `imported-routes-${suffix}.html`,
      siteType: 'landing_page',
      pages: [
        {
          title: 'Inicio importado',
          filename: 'index.html',
          html: '<!doctype html><html><body><main><h1>Inicio importado</h1><a href="./offer.html">Ver oferta</a></main></body></html>'
        },
        {
          title: 'Oferta importada',
          filename: 'offer.html',
          html: '<!doctype html><html><body><main><h1>Oferta importada</h1></main></body></html>'
        }
      ]
    })
    const importedPages = created.site.theme.pages
    const homePageId = importedPages.find(page => page.title === 'Inicio importado')?.id
    const offerPageId = importedPages.find(page => page.title === 'Oferta importada')?.id
    assert.ok(homePageId)
    assert.ok(offerPageId)
    assert.equal(importedPages.find(page => page.id === homePageId)?.slug, 'rstk01')
    assert.equal(importedPages.find(page => page.id === offerPageId)?.slug, 'rstk02')

    site = await updateSite(created.site.id, {
      status: 'published',
      theme: {
        ...created.site.theme,
        pages: importedPages.map(page => (
          page.id === offerPageId ? { ...page, slug: 'oferta' } : page
        ))
      }
    })

    const pageResolution = await resolvePublicSiteForHost('example.test', { path: '/oferta' })
    assert.equal(pageResolution.ok, true)
    assert.equal(pageResolution.site.id, site.id)
    assert.equal(pageResolution.pageId, offerPageId)

    const pageHtml = await renderPublicSiteHtml(pageResolution.site, {
      pageId: pageResolution.pageId,
      pagePath: pageResolution.pagePath,
      trackingEnabled: false
    })
    assert.match(pageHtml, /<h1[^>]*>Oferta importada<\/h1>/)
    assert.doesNotMatch(pageHtml, /<h1[^>]*>Inicio importado<\/h1>/)

    const homeHtml = await renderPublicSiteHtml(site, {
      pageId: homePageId,
      trackingEnabled: false
    })
    assert.match(homeHtml, /href="\/oferta"/)

    const settings = await setSitesPublicDefaultRoute(site.id, offerPageId)
    assert.equal(settings.defaultRoute.siteId, site.id)
    assert.equal(settings.defaultRoute.pageId, offerPageId)
    assert.equal(settings.defaultRoute.path, '/')
    assert.equal(settings.defaultRoute.pagePath, '/oferta')

    const rootResolution = await resolvePublicSiteForHost('example.test', { path: '/' })
    assert.equal(rootResolution.ok, true)
    assert.equal(rootResolution.site.id, site.id)
    assert.equal(rootResolution.pageId, offerPageId)

    const rootHtml = await renderPublicSiteHtml(rootResolution.site, {
      pageId: rootResolution.pageId,
      pagePath: rootResolution.pagePath,
      trackingEnabled: false
    })
    assert.match(rootHtml, /<h1[^>]*>Oferta importada<\/h1>/)
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('imported ZIP pages honor trailing numeric filename order', async () => {
  const suffix = Date.now()
  let site

  try {
    const zip = new JSZip()
    zip.file('Landing-01.html', '<!doctype html><html><head><title>Landing-01</title></head><body><main><h1>Landing</h1><a href="./Form-02.html">Aplicar</a></main></body></html>')
    zip.file('Booked-03.html', '<!doctype html><html><head><title>Booked-03</title></head><body><main><h1>Booked</h1></main></body></html>')
    zip.file('Form-02.html', '<!doctype html><html><head><title>Form-02</title></head><body><main><h1>Form</h1><a href="./Booked-03.html">Agendar</a></main></body></html>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const created = await createImportedSiteFromHtml({
      name: `HTML importado ordenado ${suffix}`,
      filename: `ordered-pages-${suffix}.zip`,
      siteType: 'landing_page',
      fileBase64: buffer.toString('base64')
    })
    site = created.site

    assert.deepEqual(
      site.theme.pages.map(page => page.importedAssetPath),
      ['Landing-01.html', 'Form-02.html', 'Booked-03.html']
    )
    assert.deepEqual(
      site.theme.pages.map(page => page.title),
      ['Landing-01', 'Form-02', 'Booked-03']
    )
    assert.deepEqual(
      site.theme.pages.map(page => page.slug),
      ['rstk01', 'rstk02', 'rstk03']
    )
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
  }
})

test('deleting the configured default route clears domain settings', async () => {
  const previousConfig = await snapshotDomainConfig()
  const suffix = Date.now()
  let site

  try {
    await configureVerifiedPublicDomain()
    site = await createSite({
      name: 'Default temporal',
      slug: `default-temporal-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true
    })

    await setSitesPublicDefaultRoute(site.id)
    assert.equal((await getSitesDomainSettings()).defaultRoute.siteId, site.id)

    await deleteSite(site.id)
    site = null

    const settings = await getSitesDomainSettings()
    assert.equal(settings.defaultRoute, null)
    assert.equal(await getAppConfig(DOMAIN_KEYS.defaultRoute), null)
    assert.equal(await getAppConfig(DOMAIN_KEYS.defaultRoutePage), null)
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('different verified domains can use different root routes', async () => {
  const previousConfig = await snapshotDomainConfig()
  const suffix = Date.now()
  let alphaSite
  let betaSite

  try {
    await restoreDomainConfig(previousConfig)
    await Promise.all([
      setAppConfig(DOMAIN_KEYS.domain, ''),
      setAppConfig(DOMAIN_KEYS.verified, ''),
      setAppConfig(DOMAIN_KEYS.checkedAt, ''),
      setAppConfig(DOMAIN_KEYS.error, ''),
      setAppConfig(DOMAIN_KEYS.defaultRoute, ''),
      setAppConfig(DOMAIN_KEYS.defaultRoutePage, '')
    ])

    alphaSite = await createSite({
      name: 'Landing dominio alpha',
      slug: `landing-alpha-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true
    })
    betaSite = await createSite({
      name: 'Landing dominio beta',
      slug: `landing-beta-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        pageMode: 'website',
        pages: [
          { id: 'page-home', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
          { id: 'page-offer', title: 'Oferta', slug: 'oferta', sortOrder: 1 }
        ]
      }
    })

    await db.run(`
      INSERT INTO public_site_domains (
        id,
        domain,
        render_domain_verified,
        render_domain_checked_at,
        render_domain_error,
        default_route_site_id,
        default_route_page_id
      ) VALUES
        (?, ?, 1, ?, NULL, ?, NULL),
        (?, ?, 1, ?, NULL, ?, ?)
    `, [
      `domain-alpha-${suffix}`,
      'alpha.example.test',
      new Date().toISOString(),
      alphaSite.id,
      `domain-beta-${suffix}`,
      'beta.example.test',
      new Date().toISOString(),
      betaSite.id,
      'page-offer'
    ])

    const alphaRoot = await resolvePublicSiteForHost('alpha.example.test', { path: '/' })
    assert.equal(alphaRoot.ok, true)
    assert.equal(alphaRoot.site.id, alphaSite.id)
    assert.equal(alphaRoot.pageId, '')

    const betaRoot = await resolvePublicSiteForHost('beta.example.test', { path: '/' })
    assert.equal(betaRoot.ok, true)
    assert.equal(betaRoot.site.id, betaSite.id)
    assert.equal(betaRoot.pageId, 'page-offer')

    const betaDirectPage = await resolvePublicSiteForHost('beta.example.test', { path: '/oferta' })
    assert.equal(betaDirectPage.ok, true)
    assert.equal(betaDirectPage.site.id, betaSite.id)
    assert.equal(betaDirectPage.pageId, 'page-offer')
  } finally {
    if (betaSite) await deleteSite(betaSite.id).catch(() => undefined)
    if (alphaSite) await deleteSite(alphaSite.id).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})
