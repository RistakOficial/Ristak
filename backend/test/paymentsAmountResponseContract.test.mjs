import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { __transactionsControllerTestHooks } from '../src/controllers/transactionsController.js'
import {
  serializePaymentAmount,
  serializePaymentRowAmount
} from '../src/utils/paymentAmountSerialization.js'

test('el serializer publico conserva payments.amount como numero tras migrar a NUMERIC', () => {
  const { paymentAmountForResponse } = __transactionsControllerTestHooks
  assert.equal(paymentAmountForResponse('1200.123456'), 1200.123456)
  assert.equal(paymentAmountForResponse(800), 800)
  assert.equal(paymentAmountForResponse(null), null)
  assert.equal(paymentAmountForResponse(''), null)
  assert.equal(paymentAmountForResponse('monto-invalido'), null)
})

test('el helper compartido normaliza filas NUMERIC sin mutar la fila de base', () => {
  const stored = { id: 'pay_numeric', amount: '987.654321', currency: 'MXN' }
  const serialized = serializePaymentRowAmount(stored)

  assert.deepEqual(serialized, { id: 'pay_numeric', amount: 987.654321, currency: 'MXN' })
  assert.equal(stored.amount, '987.654321')
  assert.equal(serializePaymentAmount('0.000001'), 0.000001)
})

test('el bootstrap crea payments.amount por dialecto sin cambiar SQLite', async () => {
  const source = await readFile(new URL('../src/config/database.js', import.meta.url), 'utf8')
  assert.match(source, /amount \$\{usePostgres \? 'NUMERIC\(20, 6\)' : 'REAL'\}/)
})
