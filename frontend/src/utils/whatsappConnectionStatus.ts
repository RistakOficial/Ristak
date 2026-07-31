import type { BadgeVariant } from '@/components/common'

export interface WhatsAppOfficialConnectionStatusInput {
  provider?: string | null
  phoneStatus?: string | null
  apiEnabled: boolean
  standaloneQr: boolean
  needsMetaReconnect?: boolean
}

export interface WhatsAppOfficialConnectionStatus {
  label: string
  variant: BadgeVariant
}

export function getWhatsAppOfficialConnectionStatus({
  provider,
  phoneStatus,
  apiEnabled,
  standaloneQr,
  needsMetaReconnect = false
}: WhatsAppOfficialConnectionStatusInput): WhatsAppOfficialConnectionStatus {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  const normalizedPhoneStatus = String(phoneStatus || '').trim().toUpperCase()

  if (standaloneQr) {
    return { label: 'Sin API oficial', variant: 'neutral' }
  }

  if (apiEnabled) {
    if (normalizedProvider === 'meta_direct') {
      return { label: 'API de Meta conectada', variant: 'success' }
    }
    if (normalizedProvider === 'ycloud') {
      return { label: 'YCloud conectado', variant: 'success' }
    }
    return { label: 'API conectada', variant: 'success' }
  }

  if (
    normalizedProvider === 'meta_direct' &&
    (needsMetaReconnect || normalizedPhoneStatus === 'AUTHORIZATION_REQUIRED')
  ) {
    return { label: 'Reconectar Meta', variant: 'warning' }
  }

  if (normalizedProvider === 'meta_direct') {
    return { label: 'API de Meta desconectada', variant: 'neutral' }
  }
  if (normalizedProvider === 'ycloud') {
    return { label: 'YCloud desconectado', variant: 'neutral' }
  }
  return { label: 'API desconectada', variant: 'neutral' }
}
