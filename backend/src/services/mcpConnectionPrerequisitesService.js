import {
  isAnyPaymentProviderConnected,
  isAnyRecurringPaymentProviderConnected,
  isClipConnected,
  isConektaConnected,
  isEmailConnected,
  isGoogleCalendarConnected,
  isHighLevelConnected,
  isMercadoPagoConnected,
  isMetaAdsConnected,
  isMetaSocialConnected,
  isRebillConnected,
  isStripeConnected,
  isWhatsAppConnected
} from './integrationConnectionStateService.js'

const CHECKS = Object.freeze({
  email: isEmailConnected,
  clip: isClipConnected,
  conekta: isConektaConnected,
  google_calendar: isGoogleCalendarConnected,
  highlevel: isHighLevelConnected,
  mercadopago: isMercadoPagoConnected,
  meta_ads: isMetaAdsConnected,
  meta_social: isMetaSocialConnected,
  payments: isAnyPaymentProviderConnected,
  payment_subscriptions: isAnyRecurringPaymentProviderConnected,
  rebill: isRebillConnected,
  stripe: isStripeConnected,
  whatsapp: isWhatsAppConnected
})

export async function getMissingMcpConnectionPrerequisites(prerequisites = []) {
  const required = [...new Set((prerequisites || []).map(value => String(value || '').trim()).filter(Boolean))]
  const results = await Promise.all(required.map(async provider => {
    const check = CHECKS[provider]
    if (!check) return { provider, connected: false }
    try {
      return { provider, connected: await check() }
    } catch {
      return { provider, connected: false }
    }
  }))
  return results.filter(result => !result.connected).map(result => result.provider)
}
