import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const serviceSource = readFileSync(
  new URL('../src/services/trackingAnalyticsService.js', import.meta.url),
  'utf8'
)

const queryStart = serviceSource.indexOf('async function querySessionMetrics')
const queryEnd = serviceSource.indexOf('\nfunction contactAnalyticsSourceCondition', queryStart)
assert.ok(queryStart >= 0 && queryEnd > queryStart)
const querySource = serviceSource.slice(queryStart, queryEnd)

test('PostgreSQL comparte los rollups exactos de sesiones sin cambiar la ruta SQLite', () => {
  assert.match(querySource, /const seriesSql = databaseDialect === 'postgres'/)
  assert.match(querySource, /identity_groups AS \(/)
  assert.match(querySource, /GROUP BY GROUPING SETS \(\s*\(visitor_identity\),\s*\(period, visitor_identity\)\s*\)/)
  assert.match(querySource, /COUNT\(DISTINCT session_id\) AS identity_sessions/)
  assert.match(querySource, /identity_rollups AS \(/)
  assert.match(querySource, /COUNT\(visitor_identity\) AS unique_visitors/)
  assert.match(querySource, /visitor_identity LIKE 'contact:%'/)
  assert.match(querySource, /MAX\(CASE WHEN contact_id = '' THEN 1 ELSE 0 END\) AS has_empty_contact/)
  assert.match(querySource, /\+ MAX\(has_empty_contact\) AS identified_contacts/)
  assert.match(querySource, /session_groups AS \(/)
  assert.match(querySource, /WHERE session_id IS NOT NULL\s+GROUP BY GROUPING SETS \(\s*\(session_id\),\s*\(period, session_id\)\s*\)/)
  assert.doesNotMatch(querySource, /WHERE session_id IS NOT NULL\s+AND session_id != ''/)
  assert.match(querySource, /complete_identity_rollups AS \(/)
  assert.match(querySource, /SELECT 1, NULL::text, 0, 0, 0, 0/)
  assert.match(querySource, /LEFT JOIN session_rollups sessions/)
  assert.match(querySource, /COALESCE\(sessions\.unique_sessions, 0\) AS unique_sessions/)

  const sqliteBranch = querySource.slice(querySource.indexOf(': `'))
  assert.match(sqliteBranch, /identity_totals AS \(/)
  assert.match(sqliteBranch, /identity_periods AS \(/)
  assert.match(sqliteBranch, /period_totals AS \(/)
  assert.doesNotMatch(sqliteBranch, /GROUPING SETS/)
})

function visitorIdentity(row) {
  if (row.contactId !== null && row.contactId !== '') return `contact:${row.contactId}`
  if (row.visitorId !== null && row.visitorId !== '') return `visitor:${row.visitorId}`
  if (row.sessionId !== null && row.sessionId !== '') return `session:${row.sessionId}`
  return null
}

function distinct(values) {
  return new Set(values.filter(value => value !== null)).size
}

function referenceMetrics(rows) {
  const metrics = (group) => {
    const identities = new Map()
    for (const row of group) {
      const identity = visitorIdentity(row)
      if (!identities.has(identity)) identities.set(identity, new Set())
      if (row.sessionId !== null) identities.get(identity).add(row.sessionId)
    }
    return {
      pageViews: group.length,
      uniqueVisitors: distinct(group.map(visitorIdentity)),
      uniqueSessions: distinct(group.map(row => row.sessionId)),
      identifiedContacts: distinct(group.map(row => row.contactId)),
      returningUsers: [...identities.entries()]
        .filter(([identity, sessions]) => identity !== null && sessions.size > 1)
        .length
    }
  }
  return {
    total: metrics(rows),
    periods: Object.fromEntries([...new Set(rows.map(row => row.period))]
      .map(period => [period, metrics(rows.filter(row => row.period === period))]))
  }
}

function rollupMetrics(rows) {
  const metrics = (group) => {
    const identityGroups = new Map()
    for (const row of group) {
      const identity = visitorIdentity(row)
      const current = identityGroups.get(identity) || {
        pageViews: 0,
        sessions: new Set(),
        hasEmptyContact: false
      }
      current.pageViews += 1
      if (row.sessionId !== null) current.sessions.add(row.sessionId)
      if (row.contactId === '') current.hasEmptyContact = true
      identityGroups.set(identity, current)
    }

    const groups = [...identityGroups.entries()]
    const contactIdentities = groups.filter(([identity]) => identity?.startsWith('contact:')).length
    return {
      pageViews: groups.reduce((total, [, value]) => total + value.pageViews, 0),
      uniqueVisitors: groups.filter(([identity]) => identity !== null).length,
      uniqueSessions: distinct(group.map(row => row.sessionId)),
      identifiedContacts: contactIdentities + Number(groups.some(([, value]) => value.hasEmptyContact)),
      returningUsers: groups.filter(([identity, value]) => identity !== null && value.sessions.size > 1).length
    }
  }
  return {
    total: metrics(rows),
    periods: Object.fromEntries([...new Set(rows.map(row => row.period))]
      .map(period => [period, metrics(rows.filter(row => row.period === period))]))
  }
}

test('los rollups conservan NULL, strings vacíos y session_id compartido', () => {
  const rows = [
    { period: '2090-01-01', sessionId: 'a', contactId: 'c1', visitorId: 'old' },
    { period: '2090-01-01', sessionId: 'a', contactId: 'c1', visitorId: 'old' },
    { period: '2090-01-02', sessionId: 'b', contactId: 'c1', visitorId: 'new' },
    { period: '2090-01-01', sessionId: 'shared', contactId: null, visitorId: 'v2' },
    { period: '2090-01-01', sessionId: 'shared', contactId: null, visitorId: 'v3' },
    { period: '2090-01-01', sessionId: '', contactId: '', visitorId: 'v4' },
    { period: '2090-01-01', sessionId: null, contactId: null, visitorId: 'v5' },
    { period: '2090-01-01', sessionId: null, contactId: null, visitorId: null }
  ]

  const reference = referenceMetrics(rows)
  const rollup = rollupMetrics(rows)
  assert.deepEqual(rollup, reference)
  assert.equal(rollup.total.uniqueSessions, 4, 'session_id vacío cuenta; NULL no cuenta')
  assert.equal(rollup.total.identifiedContacts, 2, 'contact normal y contact vacío cuentan una vez')
  assert.equal(rollup.total.returningUsers, 1)
})
