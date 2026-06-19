import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { createSession } from '../src/services/trackingService.js'

function suffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function baseSignals(overrides = {}) {
  return {
    url: 'https://example.test/landing',
    referrer: 'https://facebook.com/',
    device_type: 'mobile',
    os: 'iOS 18',
    browser: 'Mobile Safari',
    browser_version: '18.1',
    language: 'es-MX',
    timezone: 'America/Mexico_City',
    screen_width: 390,
    screen_height: 844,
    viewport_width: 390,
    viewport_height: 720,
    color_depth: 24,
    device_pixel_ratio: 3,
    hardware_concurrency: 6,
    device_memory: 4,
    max_touch_points: 5,
    platform: 'iPhone',
    vendor: 'Apple Computer, Inc.',
    utm_source: 'facebook',
    utm_medium: 'paid',
    utm_campaign: 'black_friday',
    site_id: 'site_tracking_identity',
    public_page_id: 'home',
    ...overrides
  }
}

async function insertContact(contactId, createdAt) {
  await db.run(`
    INSERT INTO contacts (
      id,
      email,
      full_name,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `, [
    contactId,
    `${contactId}@local.invalid`,
    'Contacto Tracking',
    createdAt,
    createdAt
  ])
}

async function cleanup(marker) {
  await db.run('DELETE FROM tracking_identity_matches WHERE visitor_id LIKE ? OR session_id LIKE ?', [`%${marker}%`, `%${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE visitor_id LIKE ? OR session_id LIKE ?', [`%${marker}%`, `%${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`%${marker}%`]).catch(() => undefined)
}

test('tracking identity resolves a new visitor by exact click id', async () => {
  const id = suffix()
  const contactId = `contact_identity_click_${id}`
  const createdAt = '2099-05-01T14:00:00.000Z'
  await cleanup(id)

  try {
    await insertContact(contactId, createdAt)
    await createSession({
      session_id: `session_${id}_known`,
      visitor_id: `visitor_${id}_known`,
      contact_id: contactId,
      event_name: 'page_view',
      ts: Date.parse(createdAt),
      data: baseSignals({ gclid: `gclid_${id}` }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1'
    })

    await createSession({
      session_id: `session_${id}_anonymous`,
      visitor_id: `visitor_${id}_anonymous`,
      event_name: 'page_view',
      ts: Date.parse('2099-05-01T14:05:00.000Z'),
      data: baseSignals({ gclid: `gclid_${id}`, browser: 'Facebook In-App Browser' }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) FBAN/FBIOS'
    })

    const row = await db.get('SELECT contact_id, match_method, match_confidence FROM sessions WHERE session_id = ?', [`session_${id}_anonymous`])
    assert.equal(row.contact_id, contactId)
    assert.equal(row.match_method, 'exact_gclid')
    assert.ok(Number(row.match_confidence) >= 90)
  } finally {
    await cleanup(id)
  }
})

test('tracking identity resolves cross-browser visits with strong device and source evidence', async () => {
  const id = suffix()
  const contactId = `contact_identity_prob_${id}`
  const createdAt = '2099-05-02T14:00:00.000Z'
  await cleanup(id)

  try {
    await insertContact(contactId, createdAt)
    await createSession({
      session_id: `session_${id}_known`,
      visitor_id: `visitor_${id}_known`,
      contact_id: contactId,
      event_name: 'page_view',
      ts: Date.parse(createdAt),
      data: baseSignals({ utm_campaign: `launch_${id}`, site_id: `site_${id}` }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1'
    })

    await createSession({
      session_id: `session_${id}_facebook`,
      visitor_id: `visitor_${id}_facebook`,
      event_name: 'page_view',
      ts: Date.parse('2099-05-02T14:08:00.000Z'),
      data: baseSignals({
        browser: 'Facebook In-App Browser',
        browser_version: '520',
        utm_campaign: `launch_${id}`,
        site_id: `site_${id}`
      }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) FBAN/FBIOS'
    })

    const row = await db.get('SELECT contact_id, match_method, match_confidence FROM sessions WHERE session_id = ?', [`session_${id}_facebook`])
    assert.equal(row.contact_id, contactId)
    assert.equal(row.match_method, 'probabilistic_device_network')
    assert.ok(Number(row.match_confidence) >= 90)
  } finally {
    await cleanup(id)
  }
})

test('tracking identity does not auto-link weak lookalike traffic', async () => {
  const id = suffix()
  const contactId = `contact_identity_no_${id}`
  const createdAt = '2099-05-03T14:00:00.000Z'
  await cleanup(id)

  try {
    await insertContact(contactId, createdAt)
    await createSession({
      session_id: `session_${id}_known`,
      visitor_id: `visitor_${id}_known`,
      contact_id: contactId,
      event_name: 'page_view',
      ts: Date.parse(createdAt),
      data: baseSignals({ utm_campaign: `campaign_a_${id}`, site_id: `site_a_${id}` }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1'
    })

    await createSession({
      session_id: `session_${id}_weak`,
      visitor_id: `visitor_${id}_weak`,
      event_name: 'page_view',
      ts: Date.parse('2099-05-03T14:20:00.000Z'),
      data: baseSignals({ utm_campaign: `campaign_b_${id}`, site_id: `site_b_${id}`, referrer: 'https://google.com/' }),
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1'
    })

    const row = await db.get('SELECT contact_id, match_method, match_confidence FROM sessions WHERE session_id = ?', [`session_${id}_weak`])
    assert.equal(row.contact_id, null)
    assert.equal(row.match_method, 'probabilistic_device_network_candidate')
    assert.ok(Number(row.match_confidence) < 90)
  } finally {
    await cleanup(id)
  }
})
