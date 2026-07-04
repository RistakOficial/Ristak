import test from 'node:test'
import assert from 'node:assert/strict'

import { getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createSite,
  deleteSite,
  getSitesDomainSettings,
  resolvePublicSiteForHost,
  setSitesPublicDefaultRoute
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
