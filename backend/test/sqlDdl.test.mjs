import assert from 'node:assert/strict'
import test from 'node:test'

import { idempotentCreateViewClause } from '../src/utils/sqlDdl.js'

test('cada motor usa una sentencia idempotente válida para crear vistas', () => {
  assert.equal(idempotentCreateViewClause('postgres'), 'CREATE OR REPLACE VIEW')
  assert.equal(idempotentCreateViewClause('sqlite'), 'CREATE VIEW IF NOT EXISTS')
  assert.throws(
    () => idempotentCreateViewClause('mysql'),
    /Dialecto no soportado/
  )
})
