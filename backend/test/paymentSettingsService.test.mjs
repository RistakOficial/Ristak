import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calculatePaymentTax, normalizePaymentSettings } from '../src/services/paymentSettingsService.js'

describe('payment settings automations', () => {
  it('normalizes payment automation categories and QR fallback flags', () => {
    const settings = normalizePaymentSettings({
      automations: {
        remindersEnabled: true,
        reminderDaysBefore: 5,
        reminderChannel: 'both',
        reminderQrFallbackEnabled: true,
        receiptDeliveryEnabled: true,
        receiptDeliveryChannel: 'whatsapp',
        receiptQrFallbackEnabled: true,
        afterPaymentAction: 'send_receipt',
        afterPaymentMessage: 'Pago recibido',
        failedPaymentEnabled: true,
        failedPaymentChannel: 'email',
        failedPaymentQrFallbackEnabled: true,
        failedPaymentDelayHours: 6
      }
    })

    assert.deepEqual(settings.automations, {
      remindersEnabled: true,
      reminderDaysBefore: 5,
      reminderChannel: 'both',
      reminderQrFallbackEnabled: true,
      receiptDeliveryEnabled: true,
      receiptDeliveryChannel: 'whatsapp',
      receiptQrFallbackEnabled: true,
      afterPaymentAction: 'send_receipt',
      afterPaymentMessage: 'Pago recibido',
      failedPaymentEnabled: true,
      failedPaymentChannel: 'email',
      failedPaymentQrFallbackEnabled: true,
      failedPaymentDelayHours: 6
    })
  })

  it('falls back to safe defaults for invalid payment automation channels', () => {
    const settings = normalizePaymentSettings({
      automations: {
        reminderChannel: 'sms',
        receiptDeliveryChannel: 'push',
        failedPaymentChannel: 'qr'
      }
    })

    assert.equal(settings.automations.reminderChannel, 'whatsapp')
    assert.equal(settings.automations.receiptDeliveryChannel, 'email')
    assert.equal(settings.automations.failedPaymentChannel, 'whatsapp')
  })
})

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
