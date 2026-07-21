import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { setAppConfig } from '../src/config/database.js'

import {
  calculatePaymentTax,
  decodeGigstackTokenMetadata,
  mergeGigstackFiscalProfileTaxes,
  normalizePaymentSettings,
  normalizePaymentSettingsMode,
  resolvePaymentSettingsBusinessProfile,
  savePaymentSettings
} from '../src/services/paymentSettingsService.js'

afterEach(async () => {
  await setAppConfig('payments_settings', null)
})

function fakeGigstackToken(livemode) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ livemode, key_id: livemode ? 'sk_live_example' : 'sk_test_example' })).toString('base64url')
  return `${header}.${payload}.signature`
}

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
        gigstackTaxFactor: 'Tasa',
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
        gigstackTaxFactor: 'Tasa',
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
        gigstackDefaultDescription: 'Servicios de consultoría en mercadotecnia',
        gigstackDefaultProductKey: '82101800',
        gigstackDefaultUnitKey: 'e48',
        gigstackDefaultUnitName: 'Unidad de Servicio',
        gigstackDefaultPaymentMethod: '4',
        gigstackAutomateInvoiceOnComplete: true
      }
    })

    assert.equal(settings.taxes.gigstackDefaultProductKey, '82101800')
    assert.equal(settings.taxes.gigstackDefaultDescription, 'Servicios de consultoría en mercadotecnia')
    assert.equal(settings.taxes.gigstackDefaultUnitKey, 'E48')
    assert.equal(settings.taxes.gigstackDefaultUnitName, 'Unidad de Servicio')
    assert.equal(settings.taxes.gigstackDefaultPaymentMethod, '04')
    assert.equal(settings.taxes.gigstackAutomateInvoiceOnComplete, true)
    assert.equal(settings.taxes.gigstackAutomationType, 'pue_invoice')
    assert.equal(settings.taxes.gigstackClientMatchMode, 'email')
  })

  it('uses the Gigstack tax rate instead of the manual country rate while connected', () => {
    const settings = normalizePaymentSettings({
      taxes: {
        enabled: false,
        country: 'MX',
        rateValue: 8,
        gigstackEnabled: true,
        gigstackFiscalSource: 'gigstack',
        gigstackSatConnected: true,
        fiscalId: 'AAA010101AAA'
      }
    })

    assert.equal(settings.taxes.enabled, true)
    assert.equal(settings.taxes.rateValue, 8)
    assert.equal(settings.taxes.rateSource, 'gigstack')
    assert.equal(settings.taxes.gigstackFiscalSource, 'gigstack')
    assert.equal(settings.taxes.fiscalId, 'AAA010101AAA')
  })

  it('keeps an exempt Gigstack tax active instead of treating zero percent as missing', () => {
    const tax = calculatePaymentTax(850, {
      enabled: true,
      gigstackEnabled: true,
      gigstackTaxFactor: 'Exento',
      rateValue: 0,
      calculationMode: 'exclusive',
      country: 'MX'
    })

    assert.equal(tax.enabled, true)
    assert.equal(tax.rateValue, 0)
    assert.equal(tax.taxAmount, 0)
    assert.equal(tax.totalAmount, 850)
    assert.equal(tax.gigstackTaxFactor, 'Exento')
  })

  it('recognizes the environment embedded in Gigstack JWT keys', () => {
    assert.equal(decodeGigstackTokenMetadata(fakeGigstackToken(false)).mode, 'test')
    assert.equal(decodeGigstackTokenMetadata(fakeGigstackToken(true)).mode, 'live')
    assert.equal(decodeGigstackTokenMetadata('not-a-jwt').valid, false)
  })

  it('clears only the selected Gigstack token', () => {
    const settings = normalizePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        clearGigstackTestApiToken: true,
        gigstackTestApiToken: fakeGigstackToken(false)
      }
    }, {
      previousTaxes: {
        gigstackTestApiTokenEncrypted: 'encrypted-test-token'
      }
    })

    assert.equal(settings.taxes.hasGigstackTestApiToken, false)
    assert.equal(settings.taxes.gigstackTestApiTokenPreview, '')
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

describe('Gigstack fiscal ownership', () => {
  it('syncs fiscal identity without replacing the merchant SAT product defaults', () => {
    const taxes = mergeGigstackFiscalProfileTaxes({
      gigstackDefaultDescription: 'Servicios de consultoría en mercadotecnia',
      gigstackDefaultProductKey: '82101800',
      gigstackDefaultUnitKey: 'E48',
      gigstackDefaultUnitName: 'Unidad de Servicio',
      gigstackDefaultPaymentMethod: '99'
    }, {
      satConnected: true,
      teamId: 'team-provider',
      taxName: 'IVA',
      rateValue: 16,
      taxFactor: 'Tasa',
      calculationMode: 'inclusive',
      country: 'MX',
      fiscalId: 'AAA010101AAA',
      fiscalLegalName: 'Razón social fiscal',
      fiscalPostalCode: '06600',
      fiscalRegime: '601',
      defaultDescription: 'Default del proveedor',
      productKey: '82101702',
      unitKey: 'ACT',
      unitName: 'Actividad'
    })

    assert.equal(taxes.gigstackDefaultDescription, 'Servicios de consultoría en mercadotecnia')
    assert.equal(taxes.gigstackDefaultProductKey, '82101800')
    assert.equal(taxes.gigstackDefaultUnitKey, 'E48')
    assert.equal(taxes.gigstackDefaultUnitName, 'Unidad de Servicio')
    assert.equal(taxes.gigstackDefaultPaymentMethod, '99')
    assert.equal(taxes.fiscalId, 'AAA010101AAA')
    assert.equal(taxes.rateValue, 16)
    assert.equal(taxes.gigstackFiscalSource, 'gigstack')
  })

  it('requires the fiscal sync path before Gigstack can be activated', async () => {
    await assert.rejects(
      () => savePaymentSettings({ taxes: { gigstackEnabled: true } }),
      (error) => error.status === 409 && /Primero conecta Gigstack/.test(error.message)
    )
  })

  it('protects synced fiscal fields while keeping SAT product defaults editable', async () => {
    await savePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackFiscalSource: 'gigstack',
        gigstackSatConnected: true,
        gigstackTeamId: 'team-protected',
        taxName: 'IVA',
        rateValue: 16,
        rateSource: 'gigstack',
        gigstackTaxFactor: 'Tasa',
        calculationMode: 'inclusive',
        country: 'MX',
        fiscalId: 'AAA010101AAA',
        fiscalLegalName: 'Fiscal correcto',
        fiscalPostalCode: '06600',
        fiscalRegime: '601'
      }
    }, { allowGigstackFiscalOverride: true })

    const settings = await savePaymentSettings({
      taxes: {
        rateValue: 8,
        fiscalId: 'CAMBIO-NO-AUTORIZADO',
        gigstackDefaultProductKey: '85121600'
      }
    })

    assert.equal(settings.taxes.rateValue, 16)
    assert.equal(settings.taxes.fiscalId, 'AAA010101AAA')
    assert.equal(settings.taxes.gigstackFiscalSource, 'gigstack')
    assert.equal(settings.taxes.gigstackDefaultProductKey, '85121600')
  })
})
