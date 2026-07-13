import { useMemo } from 'react'
import type { IntegrationsStatus } from '@/services/integrationsService'
import { useIntegrationsStatus } from './useIntegrationsStatus'

export type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill'

interface PaymentGatewayCapabilities {
  loading: boolean
  highLevelConnected: boolean
  stripeConnected: boolean
  conektaConnected: boolean
  mercadoPagoConnected: boolean
  clipConnected: boolean
  rebillConnected: boolean
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
  rebillConnected: boolean
}

function getConnectionStateFromStatus(status: IntegrationsStatus | null, loading: boolean): PaymentGatewayConnectionState {
  return {
    loading,
    highLevelConnected: Boolean(status?.highlevel?.connected),
    stripeConnected: Boolean(status?.stripe?.connected),
    conektaConnected: Boolean(status?.conekta?.connected),
    mercadoPagoConnected: Boolean(status?.mercadopago?.connected),
    clipConnected: Boolean(status?.clip?.connected),
    rebillConnected: Boolean(status?.rebill?.connected)
  }
}

export function usePaymentGatewayCapabilities(): PaymentGatewayCapabilities {
  const { status, loading } = useIntegrationsStatus()
  const connectionState = getConnectionStateFromStatus(status, loading)

  return useMemo(() => {
    const {
      loading,
      highLevelConnected,
      stripeConnected,
      conektaConnected,
      mercadoPagoConnected,
      clipConnected,
      rebillConnected
    } = connectionState
    const planProviders: PaymentGatewayProvider[] = [
      ...(stripeConnected ? ['stripe' as const] : []),
      ...(conektaConnected ? ['conekta' as const] : []),
      ...(rebillConnected ? ['rebill' as const] : [])
    ]
    const subscriptionProviders: PaymentGatewayProvider[] = [
      ...(stripeConnected ? ['stripe' as const] : []),
      ...(conektaConnected ? ['conekta' as const] : []),
      ...(mercadoPagoConnected ? ['mercadopago' as const] : []),
      ...(rebillConnected ? ['rebill' as const] : [])
    ]

    return {
      loading,
      highLevelConnected,
      stripeConnected,
      conektaConnected,
      mercadoPagoConnected,
      clipConnected,
      rebillConnected,
      hasConnectedPaymentGateway: stripeConnected || conektaConnected || mercadoPagoConnected || clipConnected || rebillConnected,
      canUsePaymentPlans: highLevelConnected || planProviders.length > 0,
      canUseSubscriptions: subscriptionProviders.length > 0,
      planProviders,
      subscriptionProviders
    }
  }, [connectionState])
}
