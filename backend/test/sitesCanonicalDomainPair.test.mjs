import test from 'node:test'
import assert from 'node:assert/strict'

import { databaseReady, db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { publicSiteHostMiddleware } from '../src/controllers/sitesController.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  createSite,
  createSitesPublicDomain,
  deleteSite,
  getSite,
  resolveConnectedPublicDomainForHost,
  setSitesDomainHealthFetchForTests,
  setSitesPublicDomainDefaultRoute,
  updateSite,
  verifyPublicDomainPairConnection
} from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error',
  defaultRoute: 'sites_public_default_route_site_id',
  defaultRoutePage: 'sites_public_default_route_page_id'
}

const MANAGED_ENV_KEYS = [
  'CLIENT_ID',
  'RISTAK_CLIENT_ID',
  'INSTALLATION_ID',
  'RISTAK_INSTALLATION_ID'
]

await databaseReady
await runVersionedMigrations()

function jsonResponse(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, headers: { get: () => null }, json: async () => payload }
}

function redirectResponse(location, status = 301) {
  return {
    ok: false,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'location' ? location : null
      }
    },
    json: async () => null
  }
}

function snapshotManagedEnv() {
  return Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreManagedEnv(snapshot) {
  for (const key of MANAGED_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
}

function configureManagedIdentity() {
  delete process.env.RISTAK_CLIENT_ID
  delete process.env.RISTAK_INSTALLATION_ID
  process.env.CLIENT_ID = 'cli_domain_pair_test'
  process.env.INSTALLATION_ID = 'inst_domain_pair_test'
}

async function snapshotDomainConfig() {
  return Object.fromEntries(await Promise.all(
    Object.entries(DOMAIN_KEYS).map(async ([name, key]) => [name, await getAppConfig(key)])
  ))
}

async function restoreDomainConfig(config) {
  await Promise.all(
    Object.entries(DOMAIN_KEYS).map(([name, key]) => setAppConfig(key, config[name]))
  )
}

function currentInstallationHealth() {
  return jsonResponse({
    ok: true,
    app: 'ristak',
    client_id: 'cli_domain_pair_test',
    installation_id: 'inst_domain_pair_test'
  })
}

test('public domains register root + www and switch the canonical host', async () => {
  const previousConfig = await snapshotDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now()
  const apexDomain = `pair-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`
  let site

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async () => currentInstallationHealth())

    const created = await createSitesPublicDomain({
      domain: apexDomain,
      canonicalDomain: wwwDomain
    })

    assert.equal(created.verification.verified, true)
    const domain = created.settings.publicDomains.find(item => item.apexDomain === apexDomain)
    assert.ok(domain)
    assert.equal(domain.wwwDomain, wwwDomain)
    assert.equal(domain.canonicalDomain, wwwDomain)
    assert.equal(domain.apexDomainVerified, true)
    assert.equal(domain.wwwDomainVerified, true)
    assert.equal(domain.domainPairVerified, true)

    const apexResolution = await resolveConnectedPublicDomainForHost(apexDomain)
    assert.equal(apexResolution.ok, true)
    assert.equal(apexResolution.canonicalDomain, wwwDomain)
    assert.equal(apexResolution.shouldRedirectToCanonical, true)

    const wwwResolution = await resolveConnectedPublicDomainForHost(wwwDomain)
    assert.equal(wwwResolution.ok, true)
    assert.equal(wwwResolution.shouldRedirectToCanonical, false)

    site = await createSite({
      name: `Canonical selection ${suffix}`,
      slug: `canonical-selection-${suffix}`,
      siteType: 'landing_page',
      blankCanvas: true
    })
    const publishedSite = await updateSite(site.id, {
      domain: apexDomain,
      status: 'published'
    })
    assert.equal(publishedSite.domain, wwwDomain)

    const updated = await setSitesPublicDomainDefaultRoute(domain.id, '', '', apexDomain)
    const updatedDomain = updated.publicDomains.find(item => item.id === domain.id)
    assert.equal(updatedDomain.canonicalDomain, apexDomain)
    assert.equal((await resolveConnectedPublicDomainForHost(wwwDomain)).shouldRedirectToCanonical, true)
    assert.equal((await getSite(site.id, { includeBlocks: false })).domain, apexDomain)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    if (site) await deleteSite(site.id).catch(() => undefined)
    await db.run('DELETE FROM public_site_domains WHERE domain = ?', [apexDomain]).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('a reachable root is kept while www remains visibly pending', async () => {
  const previousConfig = await snapshotDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now() + 1
  const apexDomain = `partial-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async (url) => {
      if (new URL(url).hostname === wwwDomain) {
        return jsonResponse({
          ok: true,
          app: 'ristak',
          client_id: 'cli_domain_pair_test',
          installation_id: 'another_installation'
        })
      }
      return currentInstallationHealth()
    })

    const created = await createSitesPublicDomain({
      domain: apexDomain,
      canonicalDomain: apexDomain
    })

    assert.equal(created.verification.verified, false)
    assert.equal(created.verification.anyVerified, true)
    const domain = created.settings.publicDomains.find(item => item.apexDomain === apexDomain)
    assert.ok(domain)
    assert.equal(domain.apexDomainVerified, true)
    assert.equal(domain.wwwDomainVerified, false)
    assert.equal(domain.domainPairVerified, false)
    assert.match(domain.wwwDomainError, /otra instalacion de Ristak/)

    assert.equal((await resolveConnectedPublicDomainForHost(apexDomain)).ok, true)
    const wwwResolution = await resolveConnectedPublicDomainForHost(wwwDomain)
    assert.equal(wwwResolution.ok, false)
    assert.equal(wwwResolution.reason, 'domain_unverified')
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await db.run('DELETE FROM public_site_domains WHERE domain = ?', [apexDomain]).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('accepts the platform redirect only when it points from the secondary host to the canonical host', async () => {
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now() + 10
  const apexDomain = `platform-ok-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async (url) => {
      const parsed = new URL(url)
      if (parsed.hostname === apexDomain) {
        return redirectResponse(`https://${wwwDomain}${parsed.pathname}`, 301)
      }
      return currentInstallationHealth()
    })

    const verification = await verifyPublicDomainPairConnection(apexDomain, wwwDomain)
    assert.equal(verification.verified, true)
    assert.equal(verification.apex.verified, true)
    assert.equal(verification.apex.redirectedToCanonical, true)
    assert.equal(verification.www.verified, true)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
  }
})

test('rejects a canonical host redirected away by the platform and never builds a loop', async () => {
  const previousConfig = await snapshotDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now() + 11
  const apexDomain = `platform-loop-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async (url) => {
      const parsed = new URL(url)
      if (parsed.hostname === wwwDomain) {
        return redirectResponse(`https://${apexDomain}${parsed.pathname}`, 301)
      }
      return currentInstallationHealth()
    })

    const created = await createSitesPublicDomain({
      domain: apexDomain,
      canonicalDomain: wwwDomain
    })
    const domain = created.settings.publicDomains.find(item => item.apexDomain === apexDomain)
    assert.ok(domain)
    assert.equal(domain.apexDomainVerified, true)
    assert.equal(domain.wwwDomainVerified, false)
    assert.match(domain.wwwDomainError, /redirige a .* antes de llegar a Ristak/)

    const apexResolution = await resolveConnectedPublicDomainForHost(apexDomain)
    assert.equal(apexResolution.ok, true)
    assert.equal(apexResolution.shouldRedirectToCanonical, false)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await db.run('DELETE FROM public_site_domains WHERE domain = ?', [apexDomain]).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('rechecks a cached secondary host before redirecting and suppresses a newly introduced loop', async () => {
  const previousConfig = await snapshotDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now() + 12
  const apexDomain = `platform-stale-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async () => currentInstallationHealth())
    await createSitesPublicDomain({ domain: apexDomain, canonicalDomain: wwwDomain })

    setSitesDomainHealthFetchForTests(async (url) => {
      const parsed = new URL(url)
      if (parsed.hostname === wwwDomain) {
        return redirectResponse(`https://${apexDomain}${parsed.pathname}`, 301)
      }
      return currentInstallationHealth()
    })

    const resolution = await resolveConnectedPublicDomainForHost(apexDomain)
    assert.equal(resolution.ok, true)
    assert.equal(resolution.shouldRedirectToCanonical, false)
    assert.equal(resolution.domainConfig.wwwDomainVerified, false)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await db.run('DELETE FROM public_site_domains WHERE domain = ?', [apexDomain]).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})

test('public page and privacy requests permanently redirect to the selected canonical host', async () => {
  const previousConfig = await snapshotDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const suffix = Date.now() + 2
  const apexDomain = `redirect-${suffix}.example.test`
  const wwwDomain = `www.${apexDomain}`
  let site

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async () => currentInstallationHealth())
    site = await createSite({
      name: `Canonical redirect ${suffix}`,
      slug: `canonical-redirect-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true
    })
    await createSitesPublicDomain({ domain: apexDomain, canonicalDomain: wwwDomain })

    const response = {
      headers: {},
      redirectStatus: null,
      redirectUrl: '',
      set(name, value) {
        if (typeof name === 'string') this.headers[name] = value
        else Object.assign(this.headers, name)
        return this
      },
      redirect(status, url) {
        this.redirectStatus = status
        this.redirectUrl = url
        return this
      }
    }
    let nextCalled = false
    await publicSiteHostMiddleware({
      method: 'GET',
      path: `/${site.slug}`,
      originalUrl: `/${site.slug}?utm_source=canonical-test`,
      url: `/${site.slug}?utm_source=canonical-test`,
      query: { utm_source: 'canonical-test' },
      headers: { host: apexDomain, accept: 'text/html' },
      hostname: apexDomain,
      protocol: 'https'
    }, response, () => {
      nextCalled = true
    })

    assert.equal(nextCalled, false)
    assert.equal(response.redirectStatus, 308)
    assert.equal(
      response.redirectUrl,
      `https://${wwwDomain}/${site.slug}?utm_source=canonical-test`
    )

    const privacyResponse = {
      headers: {},
      redirectStatus: null,
      redirectUrl: '',
      set(name, value) {
        if (typeof name === 'string') this.headers[name] = value
        else Object.assign(this.headers, name)
        return this
      },
      redirect(status, url) {
        this.redirectStatus = status
        this.redirectUrl = url
        return this
      }
    }
    await publicSiteHostMiddleware({
      method: 'GET',
      path: '/meta-privacy',
      originalUrl: '/meta-privacy?lang=es',
      url: '/meta-privacy?lang=es',
      query: { lang: 'es' },
      headers: { host: apexDomain, accept: 'text/html' },
      hostname: apexDomain,
      protocol: 'https'
    }, privacyResponse, () => {
      nextCalled = true
    })

    assert.equal(privacyResponse.redirectStatus, 308)
    assert.equal(privacyResponse.redirectUrl, `https://${wwwDomain}/meta-privacy?lang=es`)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    if (site) await deleteSite(site.id).catch(() => undefined)
    await db.run('DELETE FROM public_site_domains WHERE domain = ?', [apexDomain]).catch(() => undefined)
    await restoreDomainConfig(previousConfig)
  }
})
