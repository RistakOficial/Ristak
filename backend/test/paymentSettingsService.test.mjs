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
        reminderTemplateId: 'tpl_reminder',
        reminderTemplateName: 'mi_recordatorio',
        reminderTemplateLanguage: 'es_MX',
        receiptDeliveryEnabled: true,
        receiptDeliveryChannel: 'whatsapp',
        receiptQrFallbackEnabled: true,
        receiptTemplateId: 'tpl_receipt',
        receiptTemplateName: 'mi_comprobante',
        receiptTemplateLanguage: 'es_MX',
        afterPaymentAction: 'send_receipt',
        afterPaymentMessage: 'Pago recibido',
        failedPaymentEnabled: true,
        failedPaymentChannel: 'email',
        failedPaymentQrFallbackEnabled: true,
        failedPaymentTemplateId: 'tpl_failed',
        failedPaymentTemplateName: 'mi_cobro_fallido',
        failedPaymentTemplateLanguage: 'es_MX',
        failedPaymentDelayHours: 6
      }
    })

    assert.deepEqual(settings.automations, {
      remindersEnabled: true,
      reminderDaysBefore: 5,
      reminderChannel: 'both',
      reminderQrFallbackEnabled: true,
      reminderTemplateId: 'tpl_reminder',
      reminderTemplateName: 'mi_recordatorio',
      reminderTemplateLanguage: 'es_MX',
      receiptDeliveryEnabled: true,
      receiptDeliveryChannel: 'whatsapp',
      receiptQrFallbackEnabled: true,
      receiptTemplateId: 'tpl_receipt',
      receiptTemplateName: 'mi_comprobante',
      receiptTemplateLanguage: 'es_MX',
      afterPaymentAction: 'send_receipt',
      afterPaymentMessage: 'Pago recibido',
      failedPaymentEnabled: true,
      failedPaymentChannel: 'email',
      failedPaymentQrFallbackEnabled: true,
      failedPaymentTemplateId: 'tpl_failed',
      failedPaymentTemplateName: 'mi_cobro_fallido',
      failedPaymentTemplateLanguage: 'es_MX',
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
    assert.equal(settings.automations.reminderTemplateName, 'recordatorio_pago_pendiente')
    assert.equal(settings.automations.receiptTemplateName, 'comprobante_pago_recibido')
    assert.equal(settings.automations.failedPaymentTemplateName, 'pago_fallido_reintento')
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
