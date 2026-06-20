import type { WhatsAppApiStatus } from '@/services/whatsappApiService'

export const WHATSAPP_QR_FALLBACK_CONFIRM_WORD = 'QR'

export const WHATSAPP_QR_FALLBACK_TITLE = 'Activar respaldo por QR'

export const WHATSAPP_QR_PRECAUTION_TITLE = 'Precaución con WhatsApp QR'

export const WHATSAPP_QR_PRECAUTION_MESSAGE = (
  'El envío por QR usa una sesión de WhatsApp Web. WhatsApp puede cerrar esa sesión, restringir o bloquear el número; úsalo sólo si aceptas ese riesgo.'
)

export interface WhatsAppConnectionAvailability {
  hasApiConnected: boolean
  hasQrConnected: boolean
  canShowQrFallbackSwitch: boolean
}

interface SenderAvailabilityInput {
  apiEnabled?: boolean | null
  qrConnected?: boolean | null
}

const isConnectedStatus = (value?: string | null) => (
  String(value || '').trim().toLowerCase() === 'connected'
)

export const buildWhatsAppConnectionAvailability = (
  hasApiConnected: boolean,
  hasQrConnected: boolean
): WhatsAppConnectionAvailability => ({
  hasApiConnected,
  hasQrConnected,
  canShowQrFallbackSwitch: hasApiConnected && hasQrConnected
})

export const getWhatsAppStatusConnectionAvailability = (
  status?: WhatsAppApiStatus | null
): WhatsAppConnectionAvailability => {
  const phones = status?.phoneNumbers || []
  const apiConnectionActive = status?.connected === true && isConnectedStatus(status.status)
  const hasApiConnected = apiConnectionActive && phones.some((phone) => (
    phone.api_send_enabled === true ||
    phone.availability?.apiAvailable === true
  ))
  const hasQrConnected = phones.some((phone) => (
    (phone.qr_send_enabled === true && isConnectedStatus(phone.qr_status)) ||
    phone.availability?.qrReady === true
  )) || (status?.qr?.sessions || []).some((session) => isConnectedStatus(session.status))

  return buildWhatsAppConnectionAvailability(hasApiConnected, hasQrConnected)
}

export const getWhatsAppSenderConnectionAvailability = (
  senders: SenderAvailabilityInput[] = []
): WhatsAppConnectionAvailability => buildWhatsAppConnectionAvailability(
  senders.some((sender) => sender.apiEnabled === true),
  senders.some((sender) => sender.qrConnected === true)
)

export const buildWhatsAppQrFallbackMessage = (contextLabel: string) => (
  `WhatsApp API seguirá siendo el envío principal para ${contextLabel}. ` +
  'El QR sólo se usará como respaldo si la API no está disponible, Meta restringe el envío o el mensaje no puede salir por la ruta oficial. ' +
  'Este respaldo usa WhatsApp Web por QR, puede desconectarse y puede aumentar el riesgo de bloqueo del número. Actívalo sólo si aceptas ese riesgo.'
)
