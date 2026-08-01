import assert from 'node:assert/strict'
import test from 'node:test'

import { isTransientPostgresConnectionError } from '../src/utils/postgresConnectionErrors.js'

test('reintenta el timeout sin code que emite pg-pool al adquirir una conexión', () => {
  assert.equal(
    isTransientPostgresConnectionError(new Error('timeout exceeded when trying to connect')),
    true
  )
})

test('conserva la clasificación de errores transitorios por code y mensaje', () => {
  assert.equal(isTransientPostgresConnectionError({ code: 'ETIMEDOUT' }), true)
  assert.equal(
    isTransientPostgresConnectionError(new Error('Connection terminated unexpectedly')),
    true
  )
})

test('no reintenta errores permanentes de consulta o autenticación', () => {
  assert.equal(isTransientPostgresConnectionError({ code: '42601', message: 'syntax error' }), false)
  assert.equal(isTransientPostgresConnectionError({ code: '28P01', message: 'password authentication failed' }), false)
})
