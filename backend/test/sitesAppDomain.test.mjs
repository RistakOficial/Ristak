import test from 'node:test'
import assert from 'node:assert/strict'

import { getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  getSitesDomainSettings,
  isAppSubdomainHost,
  refreshSitesAppDomain,
  resolveConnectedAppDomainForHost
} from '../src/services/sitesService.js'

const APP_DOMAIN_KEYS = {
  domain: 'sites_app_domain',
  verified: 'sites_app_domain_verified',
  checkedAt: 'sites_app_domain_checked_at',
  error: 'sites_app_domain_error'
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

    const resolution = await resolveConnectedAppDomainForHost('app.ristak.test')
    assert.equal(resolution.ok, true)
    assert.equal(resolution.domain, 'app.ristak.test')

    const unrelatedResolution = await resolveConnectedAppDomainForHost('crm.ristak.test')
    assert.equal(unrelatedResolution.ok, false)
    assert.equal(unrelatedResolution.reason, 'domain_not_configured')
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
