import test from 'node:test'
import assert from 'node:assert/strict'

import { getAppConfig, setAppConfig } from '../src/config/database.js'
import { setSitesDomainHealthFetchForTests } from '../src/services/sitesService.js'
import {
  getTrackingDomainConfig,
  TRACKING_DOMAIN_CONFIG_KEYS,
  verifyAndSaveTrackingDomain
} from '../src/services/trackingDomainService.js'

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

function configureManagedIdentity() {
  delete process.env.RISTAK_CLIENT_ID
  delete process.env.RISTAK_INSTALLATION_ID
  process.env.CLIENT_ID = 'cli_current'
  process.env.INSTALLATION_ID = 'inst_current'
}

function jsonResponse(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    json: async () => payload
  }
}

async function snapshotTrackingDomainConfig() {
  return Object.fromEntries(await Promise.all(
    Object.entries(TRACKING_DOMAIN_CONFIG_KEYS).map(async ([name, key]) => [name, await getAppConfig(key)])
  ))
}

async function restoreTrackingDomainConfig(config) {
  await Promise.all(
    Object.entries(TRACKING_DOMAIN_CONFIG_KEYS).map(([name, key]) => setAppConfig(key, config[name]))
  )
}

async function setStoredTrackingDomain({ domain, verified = true, error = '' }) {
  await Promise.all([
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.domain, domain),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.verified, verified ? '1' : '0'),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.checkedAt, new Date().toISOString()),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.error, error)
  ])
}

test('tracking domain is persisted only after this installation answers', async () => {
  const previousConfig = await snapshotTrackingDomainConfig()
  const previousEnv = snapshotManagedEnv()
  const seenUrls = []

  try {
    configureManagedIdentity()
    setSitesDomainHealthFetchForTests(async (url) => {
      seenUrls.push(url)
      return jsonResponse({
        ok: true,
        app: 'ristak',
        client_id: 'cli_current',
        installation_id: 'inst_current'
      })
    })

    const result = await verifyAndSaveTrackingDomain('https://track.ristak.test/pixel')

    assert.equal(result.verification.verified, true)
    assert.equal(result.trackingDomain, 'track.ristak.test')
    assert.equal(result.trackingDomainVerified, true)
    assert.equal(seenUrls[0], 'https://track.ristak.test/health')
    assert.deepEqual(await getTrackingDomainConfig(), {
      trackingDomain: 'track.ristak.test',
      trackingDomainVerified: true,
      trackingDomainCheckedAt: result.trackingDomainCheckedAt,
      trackingDomainError: null
    })
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await restoreTrackingDomainConfig(previousConfig)
  }
})

test('a failed candidate does not replace the verified tracking domain', async () => {
  const previousConfig = await snapshotTrackingDomainConfig()
  const previousEnv = snapshotManagedEnv()

  try {
    configureManagedIdentity()
    await setStoredTrackingDomain({ domain: 'track.current.test' })
    setSitesDomainHealthFetchForTests(async () => jsonResponse({
      ok: true,
      app: 'ristak',
      client_id: 'cli_current',
      installation_id: 'inst_other'
    }))

    const result = await verifyAndSaveTrackingDomain('track.other.test')

    assert.equal(result.verification.verified, false)
    assert.equal(result.candidate.trackingDomain, 'track.other.test')
    assert.match(result.candidate.trackingDomainError, /otra instalacion de Ristak/)
    assert.equal(result.trackingDomain, 'track.current.test')
    assert.equal(result.trackingDomainVerified, true)
    assert.equal((await getTrackingDomainConfig()).trackingDomain, 'track.current.test')
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await restoreTrackingDomainConfig(previousConfig)
  }
})

test('a failed revalidation disables the current tracking domain', async () => {
  const previousConfig = await snapshotTrackingDomainConfig()
  const previousEnv = snapshotManagedEnv()

  try {
    configureManagedIdentity()
    await setStoredTrackingDomain({ domain: 'track.current.test' })
    setSitesDomainHealthFetchForTests(async () => jsonResponse({
      ok: true,
      app: 'ristak',
      client_id: 'cli_current',
      installation_id: 'inst_other'
    }))

    const result = await verifyAndSaveTrackingDomain('track.current.test')

    assert.equal(result.verification.verified, false)
    assert.equal(result.trackingDomain, 'track.current.test')
    assert.equal(result.trackingDomainVerified, false)
    assert.match(result.trackingDomainError, /otra instalacion de Ristak/)
    assert.equal((await getTrackingDomainConfig()).trackingDomainVerified, false)
  } finally {
    setSitesDomainHealthFetchForTests(null)
    restoreManagedEnv(previousEnv)
    await restoreTrackingDomainConfig(previousConfig)
  }
})
