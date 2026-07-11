import {
  isConektaConnected,
  isEmailInboundConnected,
  isGoogleCalendarConnected,
  isHighLevelConnected,
  isMercadoPagoConnected,
  isMetaConnected,
  isRebillConnected,
  isStripeConnected,
  isWhatsAppApiHistoryBackfillPending,
  isWhatsAppQrConnected
} from '../services/integrationConnectionStateService.js'
import { startConektaPaymentPlansCron, stopConektaPaymentPlansCron } from './conektaPaymentPlans.cron.js'
import { startEmailInboundSyncCron, stopEmailInboundSyncCron } from './emailInboundSync.cron.js'
import { startGoogleCalendarSyncCron, stopGoogleCalendarSyncCron } from './googleCalendarSync.cron.js'
import { startHighLevelSyncCron, stopHighLevelSyncCron } from './highlevelSync.cron.js'
import { startMercadoPagoPaymentPlansCron, stopMercadoPagoPaymentPlansCron } from './mercadoPagoPaymentPlans.cron.js'
import { startMetaSyncCron, stopMetaSyncCron } from './metaSync.cron.js'
import { startMetaVersionCron, stopMetaVersionCron } from './metaVersionCron.js'
import { startRebillPaymentPlansCron, stopRebillPaymentPlansCron } from './rebillPaymentPlans.cron.js'
import { startStripePaymentPlansCron, stopStripePaymentPlansCron } from './stripePaymentPlans.cron.js'
import { startWhatsAppApiHistoryBackfillCron, stopWhatsAppApiHistoryBackfillCron } from './whatsappApiHistoryBackfill.cron.js'
import { startWhatsAppQrWatchdogCron, stopWhatsAppQrWatchdogCron } from './whatsappQrWatchdog.cron.js'
import {
  registerIntegrationCron,
  syncIntegrationCrons,
  syncIntegrationCronsForProvider
} from './integrationCronRuntime.js'

let registered = false

export function registerIntegrationCrons() {
  if (registered) return
  registered = true

  registerIntegrationCron({
    name: 'google-calendar-sync',
    label: 'Google Calendar',
    provider: 'google-calendar',
    isEnabled: isGoogleCalendarConnected,
    start: startGoogleCalendarSyncCron,
    stop: stopGoogleCalendarSyncCron
  })

  registerIntegrationCron({
    name: 'highlevel-sync',
    label: 'HighLevel',
    provider: 'highlevel',
    isEnabled: isHighLevelConnected,
    start: startHighLevelSyncCron,
    stop: stopHighLevelSyncCron
  })

  registerIntegrationCron({
    name: 'meta-sync',
    label: 'Meta Ads y social',
    provider: 'meta',
    isEnabled: isMetaConnected,
    start: startMetaSyncCron,
    stop: stopMetaSyncCron
  })

  registerIntegrationCron({
    name: 'meta-version',
    label: 'Meta API version',
    provider: 'meta',
    isEnabled: isMetaConnected,
    start: startMetaVersionCron,
    stop: stopMetaVersionCron
  })

  registerIntegrationCron({
    name: 'stripe-payment-plans',
    label: 'Stripe planes de pago',
    provider: 'stripe',
    isEnabled: isStripeConnected,
    start: startStripePaymentPlansCron,
    stop: stopStripePaymentPlansCron
  })

  registerIntegrationCron({
    name: 'conekta-payment-plans',
    label: 'Conekta planes de pago',
    provider: 'conekta',
    isEnabled: isConektaConnected,
    start: startConektaPaymentPlansCron,
    stop: stopConektaPaymentPlansCron
  })

  registerIntegrationCron({
    name: 'mercadopago-payment-plans',
    label: 'Mercado Pago planes de pago',
    provider: 'mercadopago',
    isEnabled: isMercadoPagoConnected,
    start: startMercadoPagoPaymentPlansCron,
    stop: stopMercadoPagoPaymentPlansCron
  })

  registerIntegrationCron({
    name: 'rebill-payment-plans',
    label: 'Rebill planes de pago',
    provider: 'rebill',
    isEnabled: isRebillConnected,
    start: startRebillPaymentPlansCron,
    stop: stopRebillPaymentPlansCron
  })

  registerIntegrationCron({
    name: 'whatsapp-api-history-backfill',
    label: 'WhatsApp API historial YCloud',
    provider: 'whatsapp-api',
    isEnabled: isWhatsAppApiHistoryBackfillPending,
    start: startWhatsAppApiHistoryBackfillCron,
    stop: stopWhatsAppApiHistoryBackfillCron
  })

  registerIntegrationCron({
    name: 'whatsapp-qr-watchdog',
    label: 'WhatsApp QR watchdog',
    provider: 'whatsapp',
    isEnabled: isWhatsAppQrConnected,
    start: startWhatsAppQrWatchdogCron,
    stop: stopWhatsAppQrWatchdogCron
  })

  registerIntegrationCron({
    name: 'email-inbound-sync',
    label: 'Correo entrante IMAP',
    provider: 'email',
    isEnabled: isEmailInboundConnected,
    start: startEmailInboundSyncCron,
    stop: stopEmailInboundSyncCron
  })
}

export async function syncRegisteredIntegrationCrons(options = {}) {
  registerIntegrationCrons()
  return syncIntegrationCrons(null, options)
}

export async function syncRegisteredIntegrationCronsForProvider(provider, options = {}) {
  registerIntegrationCrons()
  return syncIntegrationCronsForProvider(provider, options)
}
