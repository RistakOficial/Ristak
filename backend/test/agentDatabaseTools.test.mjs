import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateReadOnlyBusinessSql,
  withAgentRowLimit
} from '../src/agents/tools/databaseTools.js'

test('agent database SQL guard accepts read-only SELECT queries', () => {
  const sql = validateReadOnlyBusinessSql(
    'SELECT COUNT(*) AS total FROM contacts WHERE created_at >= ?;',
    ['2026-06-01']
  )

  assert.equal(sql, 'SELECT COUNT(*) AS total FROM contacts WHERE created_at >= ?')
})

test('agent database SQL guard accepts read-only CTE queries', () => {
  const sql = validateReadOnlyBusinessSql(`
    WITH paid_contacts AS (
      SELECT contact_id, SUM(amount) AS total_paid
      FROM payments
      WHERE status = ?
      GROUP BY contact_id
    )
    SELECT COUNT(*) AS customers FROM paid_contacts
  `, ['paid'])

  assert.match(sql, /^WITH paid_contacts/i)
})

test('agent database SQL guard rejects mutations and multiple statements', () => {
  assert.throws(
    () => validateReadOnlyBusinessSql('UPDATE contacts SET full_name = ? WHERE id = ?', ['Nombre', '1']),
    /Sólo se permiten|operación no permitida/i
  )

  assert.throws(
    () => validateReadOnlyBusinessSql('SELECT * FROM contacts; SELECT * FROM payments', []),
    /una consulta/i
  )
})

test('agent database SQL guard rejects sensitive tables and columns', () => {
  assert.throws(
    () => validateReadOnlyBusinessSql('SELECT openai_api_key_encrypted FROM ai_agent_config', []),
    /no está disponible/i
  )

  assert.throws(
    () => validateReadOnlyBusinessSql('SELECT api_token FROM contacts', []),
    /columna no está disponible/i
  )
})

test('agent database SQL guard appends row limit when missing', () => {
  assert.equal(
    withAgentRowLimit('SELECT id FROM contacts ORDER BY created_at DESC', 25),
    'SELECT id FROM contacts ORDER BY created_at DESC LIMIT 25'
  )

  assert.equal(
    withAgentRowLimit('SELECT id FROM contacts LIMIT 10', 25),
    'SELECT id FROM contacts LIMIT 10'
  )
})
