import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paymentTaxSnapshotForTotal } from '../src/utils/paymentTaxSnapshot.js'

test('un plan sin elección fiscal o con impuesto apagado conserva la exclusión', () => {
  for (const tax of [undefined, null, { enabled: false }]) {
    assert.deepEqual(paymentTaxSnapshotForTotal(tax, 15700), { enabled: false })
  }
})

test('las parcialidades usan la tasa congelada sin incrementar el importe final', () => {
  const tax = { enabled: true, rateType: 'percentage', rateValue: 16, calculationMode: 'exclusive', subtotalAmount: 1000, taxAmount: 160, totalAmount: 1160 }
  const first = paymentTaxSnapshotForTotal(tax, 290)
  const remaining = paymentTaxSnapshotForTotal(tax, 870)
  assert.equal(first.totalAmount, 290)
  assert.equal(first.subtotalAmount, 250)
  assert.equal(first.taxAmount, 40)
  assert.equal(remaining.totalAmount, 870)
  assert.equal(remaining.subtotalAmount, 750)
  assert.equal(remaining.taxAmount, 120)
  assert.equal(first.taxAmount + remaining.taxAmount, tax.taxAmount)
  assert.equal(tax.totalAmount, 1160)
})

test('una tasa cero explícita conserva el tratamiento fiscal elegido', () => {
  const tax = paymentTaxSnapshotForTotal({ enabled: true, rateType: 'percentage', rateValue: 0, gigstackTaxFactor: 'Exento' }, 6000)
  assert.equal(tax.enabled, true)
  assert.equal(tax.gigstackTaxFactor, 'Exento')
  assert.equal(tax.taxAmount, 0)
  assert.equal(tax.subtotalAmount, 6000)
})
