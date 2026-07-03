import { useEffect, useMemo, useState } from 'react'
import { getIntegrationsStatus, readCachedIntegrationsStatus, type IntegrationsStatus } from '@/services/integrationsService'

export type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip'

interface PaymentGatewayCapabilities {
  loading: boolean
  highLevelConnected: boolean
  stripeConnected: boolean
  conektaConnected: boolean
  mercadoPagoConnected: boolean
  clipConnected: boolean
  hasConnectedPaymentGateway: boolean
  canUsePaymentPlans: boolean
  canUseSubscriptions: boolean
  planProviders: PaymentGatewayProvider[]
  subscriptionProviders: PaymentGatewayProvider[]
}

interface PaymentGatewayConnectionState {
  loading: boolean
  highLevelConnected: boolean
  stripeConnected: boolean
  conektaConnected: boolean
  mercadoPagoConnected: boolean
  clipConnected: boolean
}

function getConnectionStateFromStatus(status: IntegrationsStatus | null, loading: boolean): PaymentGatewayConnectionState {
  return {
    loading,
    highLevelConnected: Boolean(status?.highlevel?.connected),
    stripeConnected: Boolean(status?.stripe?.connected),
    conektaConnected: Boolean(status?.conekta?.connected),
    mercadoPagoConnected: Boolean(status?.mercadopago?.connected),
    clipConnected: Boolean(status?.clip?.connected)
  }
}

export function usePaymentGatewayCapabilities(): PaymentGatewayCapabilities {
  const [connectionState, setConnectionState] = useState<PaymentGatewayConnectionState>(() => {
    const cachedStatus = readCachedIntegrationsStatus()
    return getConnectionStateFromStatus(cachedStatus, !cachedStatus)
  })

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const data = await getIntegrationsStatus()
        if (cancelled) return
        setConnectionState(getConnectionStateFromStatus(data, false))
      } catch {
        if (cancelled) return
        const cachedStatus = readCachedIntegrationsStatus()
        setConnectionState(getConnectionStateFromStatus(cachedStatus, false))
      }
    }

    loadStatus()

    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(() => {
    const {
      loading,
      highLevelConnected,
      stripeConnected,
      conektaConnected,
      mercadoPagoConnected,
      clipConnected
    } = connectionState
    const planProviders: PaymentGatewayProvider[] = [
      ...(stripeConnected ? ['stripe' as const] : []),
      ...(conektaConnected ? ['conekta' as const] : [])
    ]
    const subscriptionProviders: PaymentGatewayProvider[] = [
      ...(stripeConnected ? ['stripe' as const] : []),
      ...(conektaConnected ? ['conekta' as const] : []),
      ...(mercadoPagoConnected ? ['mercadopago' as const] : [])
    ]

    return {
      loading,
      highLevelConnected,
      stripeConnected,
      conektaConnected,
      mercadoPagoConnected,
      clipConnected,
      hasConnectedPaymentGateway: stripeConnected || conektaConnected || mercadoPagoConnected || clipConnected,
      canUsePaymentPlans: highLevelConnected || planProviders.length > 0,
      canUseSubscriptions: subscriptionProviders.length > 0,
      planProviders,
      subscriptionProviders
    }
  }, [connectionState])
}
