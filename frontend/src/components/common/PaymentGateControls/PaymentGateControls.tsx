import React, { useEffect, useMemo, useState } from 'react'
import { CustomSelect } from '../CustomSelect'
import { NumberInput } from '../NumberInput'
import { Switch } from '../Switch'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '../PaymentPlatformLogo'
import {
  getIntegrationsStatus,
  readCachedIntegrationsStatus,
  type IntegrationsStatus
} from '@/services/integrationsService'
import styles from './PaymentGateControls.module.css'

export type PaymentGateGateway = 'stripe' | 'conekta' | 'mercadopago'

export interface PaymentGateConfig {
  enabled: boolean
  gateway: PaymentGateGateway
  amount: number
  currency: string
  productName: string
  description: string
  buttonText: string
  pendingMessage: string
  paidMessage: string
}

interface PaymentGateControlsProps {
  value?: Partial<PaymentGateConfig> | null
  onChange: (nextConfig: PaymentGateConfig) => void
  onCommit?: () => void
  title?: string
  description?: string
  currencyFallback?: string
}

const gatewayOptions: Array<{ value: PaymentGateGateway; label: string; logo: PaymentPlatformLogoId }> = [
  { value: 'stripe', label: 'Stripe', logo: 'stripe' },
  { value: 'conekta', label: 'Conekta', logo: 'conekta' },
  { value: 'mercadopago', label: 'Mercado Pago', logo: 'mercadopago' }
]

const gatewayValues = new Set<PaymentGateGateway>(gatewayOptions.map(option => option.value))

const cleanText = (value: unknown, fallback = '') => String(value ?? fallback).trim()

const normalizeCurrency = (value: unknown, fallback = 'MXN') => {
  const currency = cleanText(value || fallback || 'MXN').toUpperCase().slice(0, 3)
  return /^[A-Z]{3}$/.test(currency) ? currency : 'MXN'
}

const normalizeAmount = (value: unknown) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * 100) / 100
}

const normalizeGateway = (value: unknown): PaymentGateGateway => {
  const gateway = cleanText(value).toLowerCase() as PaymentGateGateway
  return gatewayValues.has(gateway) ? gateway : 'stripe'
}

export const normalizePaymentGateConfig = (
  value?: Partial<PaymentGateConfig> | null,
  currencyFallback = 'MXN'
): PaymentGateConfig => {
  const source = value || {}
  const productName = cleanText(source.productName, 'Pago requerido') || 'Pago requerido'

  return {
    enabled: Boolean(source.enabled),
    gateway: normalizeGateway(source.gateway),
    amount: normalizeAmount(source.amount),
    currency: normalizeCurrency(source.currency, currencyFallback),
    productName,
    description: cleanText(source.description, productName) || productName,
    buttonText: cleanText(source.buttonText, 'Completar pago') || 'Completar pago',
    pendingMessage: cleanText(
      source.pendingMessage,
      'Para continuar, completa el pago y deja esta página abierta.'
    ) || 'Para continuar, completa el pago y deja esta página abierta.',
    paidMessage: cleanText(source.paidMessage, 'Pago confirmado. Continuamos con tu solicitud.') ||
      'Pago confirmado. Continuamos con tu solicitud.'
  }
}

const isGatewayConnected = (status: IntegrationsStatus | null, gateway: PaymentGateGateway) => {
  if (!status) return false
  const gatewayStatus = gateway === 'stripe'
    ? status.stripe
    : gateway === 'conekta'
      ? status.conekta
      : status.mercadopago
  return Boolean(gatewayStatus?.connected || gatewayStatus?.configured)
}

export const PaymentGateControls: React.FC<PaymentGateControlsProps> = ({
  value,
  onChange,
  onCommit,
  title = 'Cobro requerido',
  description = 'La persona paga antes de avanzar.',
  currencyFallback = 'MXN'
}) => {
  const [integrationsStatus, setIntegrationsStatus] = useState<IntegrationsStatus | null>(() => readCachedIntegrationsStatus())
  const config = useMemo(() => normalizePaymentGateConfig(value, currencyFallback), [currencyFallback, value])
  const selectedGateway = gatewayOptions.find(option => option.value === config.gateway) || gatewayOptions[0]
  const selectedGatewayConnected = isGatewayConnected(integrationsStatus, config.gateway)

  useEffect(() => {
    let active = true
    getIntegrationsStatus()
      .then(status => {
        if (active) setIntegrationsStatus(status)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const patchConfig = (patch: Partial<PaymentGateConfig>) => {
    onChange(normalizePaymentGateConfig({ ...config, ...patch }, currencyFallback))
  }

  const enablePaymentGate = (enabled: boolean) => {
    patchConfig({
      enabled,
      amount: config.amount > 0 ? config.amount : 100,
      productName: config.productName || 'Pago requerido',
      description: config.description || config.productName || 'Pago requerido'
    })
    window.setTimeout(() => { onCommit?.() }, 0)
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.copy}>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <Switch
          checked={config.enabled}
          onChange={enablePaymentGate}
          aria-label={config.enabled ? 'Desactivar cobro requerido' : 'Activar cobro requerido'}
        />
      </div>

      {config.enabled && (
        <div className={styles.body}>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Pasarela</span>
              <CustomSelect
                value={config.gateway}
                onValueChange={(gateway) => patchConfig({ gateway: normalizeGateway(gateway) })}
                onBlur={onCommit}
                options={gatewayOptions.map(option => ({
                  value: option.value,
                  label: option.label,
                  icon: <PaymentPlatformLogo platform={option.logo} size="sm" decorative className={styles.gatewayLogo} />
                }))}
              />
              <small className={styles.gatewayStatus} data-connected={selectedGatewayConnected ? 'true' : undefined}>
                <PaymentPlatformLogo platform={selectedGateway.logo} size="sm" decorative className={styles.gatewayLogo} />
                {selectedGatewayConnected ? 'Conectada' : 'Pendiente de conectar'}
              </small>
            </label>

            <label className={styles.field}>
              <span>Monto</span>
              <NumberInput
                value={config.amount || ''}
                min="0"
                step="0.01"
                onValueChange={(amount) => patchConfig({ amount })}
                onBlur={onCommit}
              />
            </label>

            <label className={styles.field}>
              <span>Moneda</span>
              <input
                value={config.currency}
                maxLength={3}
                onChange={(event) => patchConfig({ currency: event.target.value.toUpperCase() })}
                onBlur={onCommit}
              />
            </label>

            <label className={styles.field}>
              <span>Producto</span>
              <input
                value={config.productName}
                onChange={(event) => patchConfig({ productName: event.target.value })}
                onBlur={onCommit}
              />
            </label>

            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span>Descripción</span>
              <textarea
                rows={2}
                value={config.description}
                onChange={(event) => patchConfig({ description: event.target.value })}
                onBlur={onCommit}
              />
            </label>

            <label className={styles.field}>
              <span>Botón de pago</span>
              <input
                value={config.buttonText}
                onChange={(event) => patchConfig({ buttonText: event.target.value })}
                onBlur={onCommit}
              />
            </label>

            <label className={styles.field}>
              <span>Mensaje confirmado</span>
              <input
                value={config.paidMessage}
                onChange={(event) => patchConfig({ paidMessage: event.target.value })}
                onBlur={onCommit}
              />
            </label>

            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span>Mensaje mientras paga</span>
              <textarea
                rows={2}
                value={config.pendingMessage}
                onChange={(event) => patchConfig({ pendingMessage: event.target.value })}
                onBlur={onCommit}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
