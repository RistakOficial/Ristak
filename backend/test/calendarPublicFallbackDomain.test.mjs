import test from 'node:test'
import assert from 'node:assert/strict'

import { getAppConfig, setAppConfig } from '../src/config/database.js'
import { attachPublicCalendarUrl } from '../src/services/localCalendarService.js'
import {
  getCalendarPublicBaseUrlStatus,
  resolvePublicCalendarHostForHost,
  shouldBlockCrmOnPublicCalendarFallbackHost
} from '../src/services/sitesService.js'

const PUBLIC_DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

const APP_DOMAIN_KEYS = {
  domain: 'sites_app_domain',
  verified: 'sites_app_domain_verified',
  checkedAt: 'sites_app_domain_checked_at',
  error: 'sites_app_domain_error'
}

async function snapshotConfig(keys) {
  return {
    domain: await getAppConfig(keys.domain),
    verified: await getAppConfig(keys.verified),
    checkedAt: await getAppConfig(keys.checkedAt),
    error: await getAppConfig(keys.error)
  }
}

async function restoreConfig(keys, config) {
  await Promise.all([
    setAppConfig(keys.domain, config.domain),
    setAppConfig(keys.verified, config.verified),
    setAppConfig(keys.checkedAt, config.checkedAt),
    setAppConfig(keys.error, config.error)
  ])
}

async function clearDomainConfig(keys) {
  await restoreConfig(keys, {
    domain: null,
    verified: null,
    checkedAt: null,
    error: null
  })
}

function snapshotEnv() {
  return {
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
    RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
    PUBLIC_URL: process.env.PUBLIC_URL,
    VITE_API_URL: process.env.VITE_API_URL,
    CALENDAR_PUBLIC_BASE_URL: process.env.CALENDAR_PUBLIC_BASE_URL,
    PUBLIC_CALENDAR_BASE_URL: process.env.PUBLIC_CALENDAR_BASE_URL
  }
}

function restoreEnv(previousEnv) {
  for (const key of Object.keys(previousEnv)) {
    if (previousEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousEnv[key]
    }
  }
}

function clearFallbackEnv() {
  delete process.env.RENDER_EXTERNAL_HOSTNAME
  delete process.env.PUBLIC_URL
  delete process.env.VITE_API_URL
  delete process.env.CALENDAR_PUBLIC_BASE_URL
  delete process.env.PUBLIC_CALENDAR_BASE_URL
}

test('calendar public URL falls back to Render when no public domain is connected', async () => {
  const previousPublicConfig = await snapshotConfig(PUBLIC_DOMAIN_KEYS)
  const previousEnv = snapshotEnv()

  try {
    await clearDomainConfig(PUBLIC_DOMAIN_KEYS)
    clearFallbackEnv()
    process.env.RENDER_EXTERNAL_URL = 'https://calendar-fallback.onrender.com'

    const status = await getCalendarPublicBaseUrlStatus()
    assert.equal(status.enabled, true)
    assert.equal(status.baseUrl, 'https://calendar-fallback.onrender.com')
    assert.equal(status.domain, 'calendar-fallback.onrender.com')
    assert.equal(status.source, 'render')

    const calendar = attachPublicCalendarUrl({
      id: 'rstk_cal_public_fallback',
      slug: 'agenda-principal',
      name: 'Agenda principal',
      isActive: true
    }, status)

    assert.equal(calendar.publicUrlEnabled, true)
    assert.equal(calendar.publicUrl, 'https://calendar-fallback.onrender.com/calendar/agenda-principal')
    assert.equal(calendar.publicUrlLockedToPublicCalendar, true)

    const resolution = await resolvePublicCalendarHostForHost('calendar-fallback.onrender.com')
    assert.equal(resolution.ok, true)
    assert.equal(resolution.fallback, true)
    assert.equal(resolution.source, 'render')
  } finally {
    await restoreConfig(PUBLIC_DOMAIN_KEYS, previousPublicConfig)
    restoreEnv(previousEnv)
  }
})

test('calendar public URL prefers the verified public domain over the fallback host', async () => {
  const previousPublicConfig = await snapshotConfig(PUBLIC_DOMAIN_KEYS)
  const previousEnv = snapshotEnv()

  try {
    await Promise.all([
      setAppConfig(PUBLIC_DOMAIN_KEYS.domain, 'calendarios.example.test'),
      setAppConfig(PUBLIC_DOMAIN_KEYS.verified, '1'),
      setAppConfig(PUBLIC_DOMAIN_KEYS.checkedAt, new Date().toISOString()),
      setAppConfig(PUBLIC_DOMAIN_KEYS.error, '')
    ])
    clearFallbackEnv()
    process.env.RENDER_EXTERNAL_URL = 'https://calendar-fallback.onrender.com'

    const status = await getCalendarPublicBaseUrlStatus()
    assert.equal(status.enabled, true)
    assert.equal(status.baseUrl, 'https://calendarios.example.test')
    assert.equal(status.domain, 'calendarios.example.test')
    assert.equal(status.source, 'connected_public_domain')
  } finally {
    await restoreConfig(PUBLIC_DOMAIN_KEYS, previousPublicConfig)
    restoreEnv(previousEnv)
  }
})

test('Render fallback can be treated as public-only when the CRM app domain is verified', async () => {
  const previousPublicConfig = await snapshotConfig(PUBLIC_DOMAIN_KEYS)
  const previousAppConfig = await snapshotConfig(APP_DOMAIN_KEYS)
  const previousEnv = snapshotEnv()

  try {
    await clearDomainConfig(PUBLIC_DOMAIN_KEYS)
    await Promise.all([
      setAppConfig(APP_DOMAIN_KEYS.domain, 'app.ristak.example.test'),
      setAppConfig(APP_DOMAIN_KEYS.verified, '1'),
      setAppConfig(APP_DOMAIN_KEYS.checkedAt, new Date().toISOString()),
      setAppConfig(APP_DOMAIN_KEYS.error, '')
    ])
    clearFallbackEnv()
    process.env.RENDER_EXTERNAL_URL = 'https://calendar-fallback.onrender.com'

    assert.equal(await shouldBlockCrmOnPublicCalendarFallbackHost('calendar-fallback.onrender.com'), true)
    assert.equal(await shouldBlockCrmOnPublicCalendarFallbackHost('app.ristak.example.test'), false)
  } finally {
    await restoreConfig(PUBLIC_DOMAIN_KEYS, previousPublicConfig)
    await restoreConfig(APP_DOMAIN_KEYS, previousAppConfig)
    restoreEnv(previousEnv)
  }
})
