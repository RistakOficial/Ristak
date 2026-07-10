import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  calculatePaymentTax,
  normalizePaymentSettings,
  normalizePaymentSettingsMode,
  resolvePaymentSettingsBusinessProfile
} from '../src/services/paymentSettingsService.js'

describe('payment settings automations', () => {
  it('normalizes the global payment gateway mode', () => {
    assert.equal(normalizePaymentSettingsMode('test'), 'test')
    assert.equal(normalizePaymentSettingsMode('live'), 'live')
    assert.equal(normalizePaymentSettingsMode('sandbox'), 'live')
    assert.equal(normalizePaymentSettings({ paymentMode: 'test' }).paymentMode, 'test')
    assert.equal(normalizePaymentSettings({ mode: 'live' }).paymentMode, 'live')
  })

  it('normalizes payment automation categories and QR fallback flags', () => {
    const settings = normalizePaymentSettings({
      automations: {
        remindersEnabled: true,
        reminderDaysBefore: 5,
        reminderChannel: 'both',
        reminderQrFallbackEnabled: true,
        reminderContentMode: 'direct',
        reminderMessageText: 'Texto recordatorio {{payment.url}}',
        reminderTemplateId: 'tpl_reminder',
        reminderTemplateName: 'mi_recordatorio',
        reminderTemplateLanguage: 'es_MX',
        receiptDeliveryEnabled: true,
        receiptDeliveryChannel: 'whatsapp',
        receiptQrFallbackEnabled: true,
        receiptContentMode: 'template',
        receiptMessageText: 'Texto comprobante {{payment.receipt_url}}',
        receiptTemplateId: 'tpl_receipt',
        receiptTemplateName: 'mi_comprobante',
        receiptTemplateLanguage: 'es_MX',
        afterPaymentAction: 'send_receipt',
        afterPaymentMessage: 'Pago recibido',
        failedPaymentEnabled: true,
        failedPaymentChannel: 'email',
        failedPaymentQrFallbackEnabled: true,
        failedPaymentContentMode: 'direct',
        failedPaymentMessageText: 'Texto fallido {{payment.url}}',
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
      reminderContentMode: 'direct',
      reminderMessageText: 'Texto recordatorio {{payment.url}}',
      reminderTemplateId: 'tpl_reminder',
      reminderTemplateName: 'mi_recordatorio',
      reminderTemplateLanguage: 'es_MX',
      receiptDeliveryEnabled: true,
      receiptDeliveryChannel: 'whatsapp',
      receiptQrFallbackEnabled: true,
      receiptContentMode: 'template',
      receiptMessageText: 'Texto comprobante {{payment.receipt_url}}',
      receiptTemplateId: 'tpl_receipt',
      receiptTemplateName: 'mi_comprobante',
      receiptTemplateLanguage: 'es_MX',
      afterPaymentAction: 'send_receipt',
      afterPaymentMessage: 'Pago recibido',
      failedPaymentEnabled: true,
      failedPaymentChannel: 'email',
      failedPaymentQrFallbackEnabled: true,
      failedPaymentContentMode: 'direct',
      failedPaymentMessageText: 'Texto fallido {{payment.url}}',
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

  it('keeps WhatsApp QR as an explicit payment automation channel', () => {
    const settings = normalizePaymentSettings({
      automations: {
        reminderChannel: 'whatsapp_qr',
        receiptDeliveryChannel: 'whatsapp_qr',
        failedPaymentChannel: 'whatsapp_qr'
      }
    })

    assert.equal(settings.automations.reminderChannel, 'whatsapp_qr')
    assert.equal(settings.automations.receiptDeliveryChannel, 'whatsapp_qr')
    assert.equal(settings.automations.failedPaymentChannel, 'whatsapp_qr')
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

describe('payment settings business profile defaults', () => {
  it('uses account business profile data when payment surfaces inherit from account', () => {
    const settings = normalizePaymentSettings({
      checkout: {
        useBusinessProfile: true,
        headline: 'Paga sin broncas'
      },
      receipt: {
        useBusinessProfile: true,
        title: 'Recibo'
      }
    })

    const resolved = resolvePaymentSettingsBusinessProfile(settings, {
      logoUrl: 'https://cdn.example.com/logo.png',
      name: 'Ristak Studio',
      email: 'pagos@ristak.test',
      phone: '+52 656 123 4567',
      address: 'Av. Siempre Viva 742',
      website: 'https://ristak.test',
      terms: 'Pagos no reembolsables.'
    })

    assert.equal(resolved.checkout.logoUrl, 'https://cdn.example.com/logo.png')
    assert.equal(resolved.checkout.supportEmail, 'pagos@ristak.test')
    assert.equal(resolved.checkout.supportPhone, '+52 656 123 4567')
    assert.equal(resolved.receipt.logoUrl, 'https://cdn.example.com/logo.png')
    assert.equal(resolved.receipt.businessName, 'Ristak Studio')
    assert.equal(resolved.receipt.businessEmail, 'pagos@ristak.test')
    assert.equal(resolved.receipt.businessPhone, '+52 656 123 4567')
    assert.equal(resolved.receipt.businessAddress, 'Av. Siempre Viva 742')
    assert.equal(resolved.receipt.businessWebsite, 'https://ristak.test')
    assert.equal(resolved.receipt.terms, 'Pagos no reembolsables.')
  })

  it('keeps payment-specific business data when overrides are enabled', () => {
    const settings = normalizePaymentSettings({
      checkout: {
        useBusinessProfile: false,
        logoUrl: 'https://cdn.example.com/checkout.png',
        supportEmail: 'checkout@override.test',
        supportPhone: '+52 111'
      },
      receipt: {
        useBusinessProfile: false,
        logoUrl: 'https://cdn.example.com/receipt.png',
        businessName: 'Override Corp',
        businessEmail: 'recibos@override.test',
        businessPhone: '+52 222',
        businessAddress: 'Dirección override',
        businessWebsite: 'https://override.test',
        terms: 'Términos override.'
      }
    })

    const resolved = resolvePaymentSettingsBusinessProfile(settings, {
      logoUrl: 'https://cdn.example.com/account.png',
      name: 'Cuenta Corp',
      email: 'cuenta@test.test',
      phone: '+52 333',
      address: 'Dirección cuenta',
      website: 'https://cuenta.test',
      terms: 'Términos cuenta.'
    })

    assert.equal(resolved.checkout.logoUrl, 'https://cdn.example.com/checkout.png')
    assert.equal(resolved.checkout.supportEmail, 'checkout@override.test')
    assert.equal(resolved.checkout.supportPhone, '+52 111')
    assert.equal(resolved.receipt.logoUrl, 'https://cdn.example.com/receipt.png')
    assert.equal(resolved.receipt.businessName, 'Override Corp')
    assert.equal(resolved.receipt.businessEmail, 'recibos@override.test')
    assert.equal(resolved.receipt.businessPhone, '+52 222')
    assert.equal(resolved.receipt.businessAddress, 'Dirección override')
    assert.equal(resolved.receipt.businessWebsite, 'https://override.test')
    assert.equal(resolved.receipt.terms, 'Términos override.')
  })
})
