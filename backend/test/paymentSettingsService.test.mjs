import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calculatePaymentTax } from '../src/services/paymentSettingsService.js'

describe('payment settings tax calculation', () => {
  it('adds exclusive percentage tax to Stripe payment totals', () => {
    assert.deepEqual(
      calculatePaymentTax(100, {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        calculationMode: 'exclusive',
        applyToStripe: true
      }),
      {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        calculationMode: 'exclusive',
        fiscalId: '',
        provider: 'jigsaw',
        subtotalAmount: 100,
        taxAmount: 16,
        totalAmount: 116
      }
    )
  })

  it('extracts inclusive percentage tax from the existing total', () => {
    assert.deepEqual(
      calculatePaymentTax(116, {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        calculationMode: 'inclusive',
        applyToStripe: true
      }),
      {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        calculationMode: 'inclusive',
        fiscalId: '',
        provider: 'jigsaw',
        subtotalAmount: 100,
        taxAmount: 16,
        totalAmount: 116
      }
    )
  })

  it('skips taxes when Stripe application is disabled', () => {
    assert.equal(
      calculatePaymentTax(100, {
        enabled: true,
        rateType: 'fixed',
        rateValue: 25,
        calculationMode: 'exclusive',
        applyToStripe: false
      }),
      null
    )
  })
})
