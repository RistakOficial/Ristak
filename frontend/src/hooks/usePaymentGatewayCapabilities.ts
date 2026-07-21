import { useMemo } from 'react'
import type { IntegrationsStatus } from '@/services/integrationsService'
import { useAuth } from '@/contexts/AuthContext'
import {
  hasPaymentGatewaysAccess,
  hasPaymentLinksAccess,
  hasPaymentPlansAccess,
  hasSubscriptionsAccess
} from '@/utils/accessControl'
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
  canUsePaymentLinks: boolean
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
  const { user } = useAuth()
  const canUsePaymentGateways = hasPaymentGatewaysAccess(user)
  const canUsePaymentLinks = hasPaymentLinksAccess(user)
  const canUsePaymentPlans = hasPaymentPlansAccess(user)
  const canUseSubscriptions = hasSubscriptionsAccess(user)
  const { status, loading } = useIntegrationsStatus({ enabled: canUsePaymentGateways })
  const connectionState = getConnectionStateFromStatus(canUsePaymentGateways ? status : null, loading)

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
      canUsePaymentLinks: canUsePaymentLinks && (highLevelConnected || stripeConnected || conektaConnected || mercadoPagoConnected || clipConnected || rebillConnected),
      canUsePaymentPlans: canUsePaymentPlans && (highLevelConnected || planProviders.length > 0),
      canUseSubscriptions: canUseSubscriptions && subscriptionProviders.length > 0,
      planProviders,
      subscriptionProviders
    }
  }, [canUsePaymentLinks, canUsePaymentPlans, canUseSubscriptions, connectionState])
}
