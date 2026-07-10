import type { WhatsAppApiStatus } from '@/services/whatsappApiService'

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
