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
        country: 'MX',
        calculationMode: 'exclusive'
      }),
      {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        rateSource: 'automatic',
        calculationMode: 'exclusive',
        country: 'MX',
        fiscalId: '',
        fiscalLegalName: '',
        fiscalPostalCode: '',
        fiscalRegime: '',
        provider: 'gigstack',
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
        country: 'MX',
        calculationMode: 'inclusive'
      }),
      {
        enabled: true,
        taxName: 'IVA',
        rateType: 'percentage',
        rateValue: 16,
        rateSource: 'automatic',
        calculationMode: 'inclusive',
        country: 'MX',
        fiscalId: '',
        fiscalLegalName: '',
        fiscalPostalCode: '',
        fiscalRegime: '',
        provider: 'gigstack',
        subtotalAmount: 100,
        taxAmount: 16,
        totalAmount: 116
      }
    )
  })

  it('uses the automatic country rate and ignores legacy provider gates', () => {
    const tax = calculatePaymentTax(100, {
      enabled: true,
      country: 'CO',
      calculationMode: 'exclusive',
      applyToStripe: false,
      applyToMercadoPago: false
    })

    assert.equal(tax.rateValue, 19)
    assert.equal(tax.country, 'CO')
    assert.equal(tax.taxAmount, 19)
    assert.equal(tax.totalAmount, 119)
  })

  it('skips taxes only when the global switch is off', () => {
    assert.equal(calculatePaymentTax(100, { enabled: false, country: 'MX' }), null)
  })

  it('normalizes Gigstack fiscal defaults selected from dropdowns', () => {
    const settings = normalizePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackDefaultProductKey: '82101800',
        gigstackDefaultUnitKey: 'e48',
        gigstackDefaultUnitName: 'Unidad de Servicio',
        gigstackDefaultPaymentMethod: '4',
        gigstackAutomateInvoiceOnComplete: true
      }
    })

    assert.equal(settings.taxes.gigstackDefaultProductKey, '82101800')
    assert.equal(settings.taxes.gigstackDefaultUnitKey, 'E48')
    assert.equal(settings.taxes.gigstackDefaultUnitName, 'Unidad de Servicio')
    assert.equal(settings.taxes.gigstackDefaultPaymentMethod, '04')
    assert.equal(settings.taxes.gigstackAutomateInvoiceOnComplete, true)
  })

  it('clears the saved Gigstack token when disconnecting', () => {
    const settings = normalizePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: false,
        clearGigstackApiToken: true,
        gigstackApiToken: 'new-token-that-should-be-ignored'
      }
    }, {
      previousTaxes: {
        gigstackApiTokenEncrypted: 'encrypted-token'
      }
    })

    assert.equal(settings.taxes.hasGigstackApiToken, false)
    assert.equal(settings.taxes.gigstackApiTokenPreview, '')
  })
})
