import test from 'node:test'
import assert from 'node:assert/strict'

import { getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  getVerifiedAppBaseUrl,
  getSitesDomainSettings,
  isAppSubdomainHost,
  refreshSitesAppDomain,
  resolveConnectedAppDomainForHost,
  setSitesDomainHealthFetchForTests,
  verifyAppDomainConnection
} from '../src/services/sitesService.js'

const APP_DOMAIN_KEYS = {
  domain: 'sites_app_domain',
  verified: 'sites_app_domain_verified',
  checkedAt: 'sites_app_domain_checked_at',
  error: 'sites_app_domain_error'
}

const MANAGED_ENV_KEYS = [
  'CLIENT_ID',
  'RISTAK_CLIENT_ID',
  'INSTALLATION_ID',
  'RISTAK_INSTALLATION_ID'
]

function snapshotManagedEnv() {
  return Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreManagedEnv(snapshot) {
  for (const key of MANAGED_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

function configureManagedIdentity({ clientId = 'cli_current', installationId = 'inst_current' } = {}) {
  delete process.env.RISTAK_CLIENT_ID
  delete process.env.RISTAK_INSTALLATION_ID
  process.env.CLIENT_ID = clientId
  process.env.INSTALLATION_ID = installationId
}

function jsonResponse(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    json: async () => payload
  }
}

async function snapshotAppDomainConfig() {
  return {
    domain: await getAppConfig(APP_DOMAIN_KEYS.domain),
    verified: await getAppConfig(APP_DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(APP_DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(APP_DOMAIN_KEYS.error)
  }
}

async function restoreAppDomainConfig(config) {
  await Promise.all([
    setAppConfig(APP_DOMAIN_KEYS.domain, config.domain),
    setAppConfig(APP_DOMAIN_KEYS.verified, config.verified),
    setAppConfig(APP_DOMAIN_KEYS.checkedAt, config.checkedAt),
    setAppConfig(APP_DOMAIN_KEYS.error, config.error)
  ])
}

test('verified app subdomain resolves as CRM domain', async () => {
  const previousConfig = await snapshotAppDomainConfig()

  try {
    await setAppConfig(APP_DOMAIN_KEYS.domain, 'app.ristak.test')
    await setAppConfig(APP_DOMAIN_KEYS.verified, '1')
    await setAppConfig(APP_DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(APP_DOMAIN_KEYS.error, '')

    assert.equal(isAppSubdomainHost('app.ristak.test'), true)
    assert.equal(isAppSubdomainHost('app-admin.ristak.test'), true)
    assert.equal(isAppSubdomainHost('crm.ristak.test'), false)

    const settings = await getSitesDomainSettings()
    assert.equal(settings.appDomain, 'app.ristak.test')
    assert.equal(settings.appDomainVerified, true)
    assert.equal(await getVerifiedAppBaseUrl(), 'https://app.ristak.test')

    const resolution = await resolveConnectedAppDomainForHost('app.ristak.test')
    assert.equal(resolution.ok, true)
    assert.equal(resolution.domain, 'app.ristak.test')

    const unrelatedResolution = await resolveConnectedAppDomainForHost('crm.ristak.test')
    assert.equal(unrelatedResolution.ok, false)
    assert.equal(unrelatedResolution.reason, 'domain_not_configured')

    await setAppConfig(APP_DOMAIN_KEYS.verified, '0')
    assert.equal(await getVerifiedAppBaseUrl(), '')
  } finally {
    await restoreAppDomainConfig(previousConfig)
  }
})

test('app domain verification rejects non app subdomains before persistence', async () => {
  const previousConfig = await snapshotAppDomainConfig()

  try {
    const result = await refreshSitesAppDomain({ domain: 'crm.ristak.test' })

    assert.equal(result.domain, 'crm.ristak.test')
    assert.equal(result.renderDomainVerified, false)
    assert.match(result.renderDomainError, /empiece con app/)
    assert.equal(await getAppConfig(APP_DOMAIN_KEYS.domain), previousConfig.domain)
    assert.equal(await getAppConfig(APP_DOMAIN_KEYS.verified), previousConfig.verified)
  } finally {
    await restoreAppDomainConfig(previousConfig)
  }
})

test('app domain verification accepts the current installed service only', async () => {
  const previousEnv = snapshotManagedEnv()
  const seenUrls = []

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async (url) => {
      seenUrls.push(url)
      assert.equal(new URL(url).pathname, '/health')
      return jsonResponse({
        ok: true,
        app: 'ristak',
        client_id: 'cli_current',
        installation_id: 'inst_current'
      })
    })

    const result = await verifyAppDomainConnection('app.ristak.test')

    assert.equal(result.verified, true)
    assert.equal(result.method, 'https_installation_health')
    assert.equal(result.identityField, 'installation_id')
    assert.equal(seenUrls[0], 'https://app.ristak.test/health')
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
  }
})

test('app domain verification rejects a domain connected to another installed service', async () => {
  const previousEnv = snapshotManagedEnv()

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async () => jsonResponse({
      ok: true,
      app: 'ristak',
      client_id: 'cli_current',
      installation_id: 'inst_other'
    }))

    const result = await verifyAppDomainConnection('app.ristak.test')

    assert.equal(result.verified, false)
    assert.match(result.error, /otra instalacion de Ristak/)
    assert.equal(result.details.code, 'identity_mismatch')
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
  }
})
