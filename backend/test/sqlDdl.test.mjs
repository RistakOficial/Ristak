import assert from 'node:assert/strict'
import test from 'node:test'

import { booleanProjectionExpression, idempotentCreateViewClause } from '../src/utils/sqlDdl.js'

test('cada motor usa una sentencia idempotente válida para crear vistas', () => {
  assert.equal(idempotentCreateViewClause('postgres'), 'CREATE OR REPLACE VIEW')
  assert.equal(idempotentCreateViewClause('sqlite'), 'CREATE VIEW IF NOT EXISTS')
  assert.throws(
    () => idempotentCreateViewClause('mysql'),
    /Dialecto no soportado/
  )
})

test('las vistas conservan el tipo booleano nativo de cada motor', () => {
  assert.equal(booleanProjectionExpression('referral_depth > 0', 'postgres'), 'referral_depth > 0')
  assert.equal(
    booleanProjectionExpression('referral_depth > 0', 'sqlite'),
    'CASE WHEN referral_depth > 0 THEN 1 ELSE 0 END'
  )
  assert.throws(
    () => booleanProjectionExpression('', 'postgres'),
    /necesita una condición SQL/
  )
})
