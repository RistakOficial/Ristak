import { useEffect, useMemo, useState } from 'react'
import { getIntegrationsStatus } from '@/services/integrationsService'

export type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago'

interface PaymentGatewayCapabilities {
  loading: boolean
  highLevelConnected: boolean
  stripeConnected: boolean
  conektaConnected: boolean
  mercadoPagoConnected: boolean
  hasConnectedPaymentGateway: boolean
  canUsePaymentPlans: boolean
  canUseSubscriptions: boolean
  planProviders: PaymentGatewayProvider[]
  subscriptionProviders: PaymentGatewayProvider[]
}

export function usePaymentGatewayCapabilities(): PaymentGatewayCapabilities {
  const [loading, setLoading] = useState(true)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [conektaConnected, setConektaConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const data = await getIntegrationsStatus()
        if (cancelled) return
        setHighLevelConnected(Boolean(data?.highlevel?.connected))
        setStripeConnected(Boolean(data?.stripe?.connected))
        setConektaConnected(Boolean(data?.conekta?.connected))
        setMercadoPagoConnected(Boolean(data?.mercadopago?.connected))
      } catch {
        if (cancelled) return
        setHighLevelConnected(false)
        setStripeConnected(false)
        setConektaConnected(false)
        setMercadoPagoConnected(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadStatus()

    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(() => {
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
      hasConnectedPaymentGateway: stripeConnected || conektaConnected || mercadoPagoConnected,
      canUsePaymentPlans: highLevelConnected || planProviders.length > 0,
      canUseSubscriptions: subscriptionProviders.length > 0,
      planProviders,
      subscriptionProviders
    }
  }, [conektaConnected, highLevelConnected, loading, mercadoPagoConnected, stripeConnected])
}
