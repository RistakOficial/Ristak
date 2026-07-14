import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { createSession, linkVisitorToContact } from '../src/services/trackingService.js'

function suffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function cleanup(marker) {
  await db.run('DELETE FROM tracking_identity_matches WHERE visitor_id LIKE ? OR session_id LIKE ?', [`%${marker}%`, `%${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE id LIKE ? OR session_id LIKE ? OR visitor_id LIKE ?', [`%${marker}%`, `%${marker}%`, `%${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`%${marker}%`]).catch(() => undefined)
}

async function insertContact(contactId, values = {}) {
  await db.run(`
    INSERT INTO contacts (
      id,
      email,
      full_name,
      visitor_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [
    contactId,
    `${contactId}@local.invalid`,
    'Contacto Visitor',
    values.visitor_id || null,
    values.created_at || '2099-06-01T10:00:00.000Z',
    values.updated_at || '2099-06-01T10:00:00.000Z'
  ])
}

test('tracking does not resolve a contact by ad-like numeric visitor id', async () => {
  const id = suffix()
  const contactId = `contact_ad_like_identity_${id}`
  const sessionId = `session_ad_like_identity_${id}`
  const adLikeVisitorId = '120241691100910604'

  await cleanup(id)

  try {
    await insertContact(contactId, { visitor_id: adLikeVisitorId })

    await createSession({
      session_id: sessionId,
      visitor_id: adLikeVisitorId,
      event_name: 'page_view',
      ts: Date.parse('2099-06-01T10:05:00.000Z'),
      data: {
        url: `https://example.test/landing?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}`,
        referrer: 'https://facebook.com/',
        utm_source: 'facebook',
        utm_medium: 'paid',
        ad_id: adLikeVisitorId
      },
      ip: '127.0.0.1',
      user_agent: 'Mozilla/5.0'
    })

    const row = await db.get('SELECT visitor_id, contact_id, match_method FROM sessions WHERE session_id = ?', [sessionId])
    assert.ok(row.visitor_id.startsWith('untrusted_'))
    assert.equal(row.contact_id, null)
    assert.equal(row.match_method, 'anonymous')
  } finally {
    await cleanup(id)
  }
})

test('linkVisitorToContact skips ad-like numeric visitor id history updates', async () => {
  const id = suffix()
  const contactId = `contact_ad_like_link_${id}`
  const sessionId = `session_ad_like_link_${id}`
  const adLikeVisitorId = '120241691100910604'

  await cleanup(id)

  try {
    await insertContact(contactId)
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, page_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      `row_ad_like_link_${id}`,
      sessionId,
      adLikeVisitorId,
      'page_view',
      '2099-06-01T10:00:00.000Z',
      '2099-06-01T10:00:00.000Z',
      `https://example.test/landing?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}`
    ])

    const result = await linkVisitorToContact(adLikeVisitorId, contactId, 'Contacto Visitor')
    const session = await db.get('SELECT contact_id, full_name, email FROM sessions WHERE session_id = ?', [sessionId])
    const contact = await db.get('SELECT visitor_id FROM contacts WHERE id = ?', [contactId])

    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'untrusted_visitor_id')
    assert.equal(session.contact_id, null)
    assert.equal(session.full_name, null)
    assert.equal(session.email, null)
    assert.equal(contact.visitor_id, null)
  } finally {
    await cleanup(id)
  }
})

test('linkVisitorToContact commits large history links in bounded batches', async () => {
  const id = suffix()
  const contactId = `contact_bulk_link_${id}`
  const visitorId = `visitor_bulk_link_${id}`
  const rowCount = 205

  await cleanup(id)

  try {
    await insertContact(contactId)
    for (let index = 0; index < rowCount; index += 1) {
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, event_name, started_at, created_at
        ) VALUES (?, ?, ?, 'page_view', ?, ?)
      `, [
        `row_bulk_link_${id}_${index}`,
        `session_bulk_link_${id}_${index}`,
        visitorId,
        `2099-06-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        `2099-06-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`
      ])
    }

    const result = await linkVisitorToContact(visitorId, contactId, 'Contacto Bulk')
    const linked = await db.get(`
      SELECT COUNT(*) AS total
      FROM sessions
      WHERE visitor_id = ? AND contact_id = ?
    `, [visitorId, contactId])

    assert.equal(result.success, true)
    assert.equal(result.updated, rowCount)
    assert.equal(result.batches, 2)
    assert.equal(Number(linked.total), rowCount)
  } finally {
    await cleanup(id)
  }
})
