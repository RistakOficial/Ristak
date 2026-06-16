import { logger } from '../utils/logger.js'

export const WHATSAPP_NUMBER_CHANGED_EVENT = 'whatsapp-number-changed'

function cleanString(value) {
  return String(value ?? '').trim()
}

export function buildWhatsAppNumberChangeEvent(payload = {}) {
  const contactId = cleanString(payload.contactId)
  const previousPhoneNumberId = cleanString(payload.previousPhoneNumberId || payload.previous_phone_number_id)
  const newPhoneNumberId = cleanString(payload.newPhoneNumberId || payload.new_phone_number_id)
  if (!contactId || previousPhoneNumberId === newPhoneNumberId) return null

  return {
    contactId,
    previousPhoneNumberId: previousPhoneNumberId || null,
    newPhoneNumberId: newPhoneNumberId || null,
    routingReason: cleanString(payload.reason || payload.routingReason) || 'Cambio de número preferido de WhatsApp',
    routingSource: cleanString(payload.source || payload.routingSource) || 'manual',
    changedAt: cleanString(payload.changedAt) || new Date().toISOString()
  }
}

export function triggerWhatsAppNumberChangedAutomation(payload = {}) {
  const event = buildWhatsAppNumberChangeEvent(payload)
  if (!event) return

  setImmediate(() => {
    import('./automationEngine.js')
      .then((engine) => engine.handleAutomationEvent(WHATSAPP_NUMBER_CHANGED_EVENT, event))
      .catch((error) => {
        logger.warn(`No se pudo disparar automatización por cambio de número WhatsApp: ${error.message}`)
      })
  })
}
