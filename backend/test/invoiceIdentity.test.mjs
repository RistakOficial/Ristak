import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildInvoiceReferenceCandidates,
  firstInvoiceIdentity,
  normalizeInvoiceNumber,
  normalizeInvoiceReference
} from '../src/utils/invoiceIdentity.js'

describe('invoice identity helpers', () => {
  it('normalizes GoHighLevel invoice references to the same invoice number', () => {
    const variants = [
      '000624',
      'INV-000624',
      'Invoice #000624',
      'Invoice #INV-000624',
      'invoice # inv-000624',
      'Factura #INV-000624'
    ]

    for (const variant of variants) {
      assert.equal(normalizeInvoiceReference(variant), '000624')
    }
  })

  it('normalizes invoice numbers with known prefixes', () => {
    assert.equal(normalizeInvoiceNumber('INV-000623'), '000623')
    assert.equal(normalizeInvoiceNumber('Invoice #INV-000623'), '000623')
    assert.equal(normalizeInvoiceNumber(' 000623 '), '000623')
  })

  it('builds every stored reference variant used by payment webhooks and invoice sync', () => {
    assert.deepEqual(buildInvoiceReferenceCandidates('INV-000623'), [
      '000623',
      'INV-000623',
      'Invoice #000623',
      'Invoice #INV-000623'
    ])
  })

  it('returns the first usable invoice identity from mixed payload fields', () => {
    assert.equal(firstInvoiceIdentity('', null, 'Invoice #INV-000621'), '000621')
  })

  it('does not treat generic titles as invoice references', () => {
    assert.equal(normalizeInvoiceReference('New Invoice'), null)
    assert.equal(normalizeInvoiceReference('Text2Pay - Addi'), null)
  })
})
