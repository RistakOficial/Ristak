import React, { useEffect, useMemo, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { CustomSelect } from '../CustomSelect'
import { NumberInput } from '../NumberInput'
import { Switch } from '../Switch'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '../PaymentPlatformLogo'
import {
  getIntegrationsStatus,
  readCachedIntegrationsStatus,
  type IntegrationsStatus
} from '@/services/integrationsService'
import { productsService, type ProductItem, type ProductPrice } from '@/services/productsService'
import styles from './PaymentGateControls.module.css'

export type PaymentGateGateway = 'stripe' | 'conekta' | 'mercadopago'

// Modo por bloque SEGURO: solo puede forzar 'test' (probar sin cobrar aunque la
// plataforma esté en live). 'inherit' = usa el modo global. Nunca 'live' → imposible
// cobrar de verdad por accidente desde un bloque marcado como prueba.
export type PaymentGateMode = 'inherit' | 'test'

export interface PaymentGateMsi {
  enabled: boolean
  maxInstallments: number
}

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
  mode: PaymentGateMode
  msi: PaymentGateMsi
}

// Meses sin intereses: solo Conekta y Mercado Pago lo permiten en cobro simple.
export const MSI_GATEWAYS = new Set<PaymentGateGateway>(['conekta', 'mercadopago'])
export const MSI_INSTALLMENT_CHOICES = [3, 6, 9, 12, 18, 24]

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

const normalizeMode = (value: unknown): PaymentGateMode =>
  cleanText(value).toLowerCase() === 'test' ? 'test' : 'inherit'

const normalizeMsi = (value: unknown): PaymentGateMsi => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<PaymentGateMsi> & { months?: number; max_installments?: number }
  const enabled = Boolean(source.enabled)
  const requested = Number(source.maxInstallments ?? source.max_installments ?? source.months ?? 0)
  if (!enabled || !Number.isFinite(requested) || requested <= 1) return { enabled: false, maxInstallments: 0 }
  const allowed = MSI_INSTALLMENT_CHOICES.filter(months => months <= requested)
  return { enabled: true, maxInstallments: allowed.length ? allowed[allowed.length - 1] : MSI_INSTALLMENT_CHOICES[0] }
}

// Catálogo de productos (opcional): el id y el monto pueden venir en varios campos.
const productKeyOf = (product: ProductItem) => String(product.id || product._id || product.localId || '')
const priceKeyOf = (price: ProductPrice) => String(price.id || price._id || price.localId || '')
const priceAmountOf = (price: ProductPrice) => {
  const amount = Number(price.amount ?? price.price ?? 0)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0
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
      'Pago confirmado. Continuamos con tu solicitud.',
    mode: normalizeMode(source.mode),
    msi: normalizeMsi(source.msi ?? (source as { installments?: unknown }).installments)
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

  // Catálogo opcional: sincroniza nombre + precio de un producto de la DB (editable).
  const [products, setProducts] = useState<ProductItem[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [selectedProductId, setSelectedProductId] = useState('')

  useEffect(() => {
    if (!config.enabled) return
    let active = true
    setLoadingProducts(true)
    productsService.listProducts({ limit: 100, includePrices: true })
      .then(result => { if (active) setProducts(result.products) })
      .catch(() => {})
      .finally(() => { if (active) setLoadingProducts(false) })
    return () => { active = false }
  }, [config.enabled])

  const selectedProduct = useMemo(
    () => products.find(product => productKeyOf(product) === selectedProductId) || null,
    [products, selectedProductId]
  )
  const productPrices = selectedProduct?.prices || []

  const applyCatalogProduct = (id: string) => {
    setSelectedProductId(id)
    if (!id) return
    const product = products.find(item => productKeyOf(item) === id)
    if (!product) return
    const firstPrice = (product.prices || [])[0]
    patchConfig({
      productName: product.name || config.productName,
      ...(firstPrice ? { amount: priceAmountOf(firstPrice) } : {})
    })
    window.setTimeout(() => { onCommit?.() }, 0)
  }

  const applyCatalogPrice = (key: string) => {
    const price = productPrices.find(item => priceKeyOf(item) === key)
    if (!price) return
    patchConfig({ amount: priceAmountOf(price) })
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
          <div className={styles.field}>
            <div className={styles.toggleRow}>
              <div className={styles.toggleCopy}>
                <strong>Realizar cobro modo test</strong>
                <span>Cobra en modo prueba aunque la plataforma esté en vivo.</span>
              </div>
              <Switch
                checked={config.mode === 'test'}
                onChange={(checked) => {
                  patchConfig({ mode: checked ? 'test' : 'inherit' })
                  window.setTimeout(() => { onCommit?.() }, 0)
                }}
                aria-label={config.mode === 'test' ? 'Desactivar cobro modo test' : 'Activar cobro modo test'}
              />
            </div>
            {config.mode === 'test' && (
              <p className={styles.testNote}>
                <FlaskConical size={15} />
                Este bloque está en modo prueba. Los pagos aquí no serán cobros reales.
              </p>
            )}
          </div>

          <div className={styles.grid}>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span>Producto del catálogo (opcional)</span>
              <CustomSelect
                value={selectedProductId}
                onValueChange={applyCatalogProduct}
                onBlur={onCommit}
                options={[
                  { value: '', label: loadingProducts ? 'Cargando productos…' : (products.length ? 'Sin producto — captura manual' : 'No tienes productos guardados — captura manual') },
                  ...products.map(product => ({ value: productKeyOf(product), label: product.name }))
                ]}
              />
            </label>

            {selectedProduct && productPrices.length > 1 && (
              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span>Precio del producto</span>
                <CustomSelect
                  value=""
                  onValueChange={applyCatalogPrice}
                  onBlur={onCommit}
                  options={productPrices.map(price => ({
                    value: priceKeyOf(price),
                    label: `${price.name || 'Precio'} · ${priceAmountOf(price).toFixed(2)} ${price.currency || config.currency}`
                  }))}
                />
              </label>
            )}

            <label className={styles.field}>
              <span>Pasarela</span>
              <CustomSelect
                value={config.gateway}
                onValueChange={(gateway) => patchConfig({ gateway: normalizeGateway(gateway) })}
                onBlur={onCommit}
                options={gatewayOptions.map(option => ({
                  value: option.value,
                  label: `${option.label} · ${isGatewayConnected(integrationsStatus, option.value) ? 'Conectado' : 'Sin conectar'}`,
                  icon: <PaymentPlatformLogo platform={option.logo} size="sm" decorative className={styles.gatewayLogo} />
                }))}
              />
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

          {MSI_GATEWAYS.has(config.gateway) && (
            <div className={styles.field}>
              <div className={styles.toggleRow}>
                <div className={styles.toggleCopy}>
                  <strong>Meses sin intereses</strong>
                  <span>Ofrece diferido a meses en {selectedGateway.label}.</span>
                </div>
                <Switch
                  checked={config.msi.enabled}
                  onChange={(enabled) => {
                    patchConfig({ msi: { enabled, maxInstallments: enabled ? (config.msi.maxInstallments || 12) : 0 } })
                    window.setTimeout(() => { onCommit?.() }, 0)
                  }}
                  aria-label={config.msi.enabled ? 'Desactivar meses sin intereses' : 'Activar meses sin intereses'}
                />
              </div>
              {config.msi.enabled && (
                <label className={styles.field}>
                  <span>Diferir hasta</span>
                  <CustomSelect
                    value={String(config.msi.maxInstallments || 12)}
                    onValueChange={(value) => patchConfig({ msi: { enabled: true, maxInstallments: Number(value) } })}
                    onBlur={onCommit}
                    options={MSI_INSTALLMENT_CHOICES.map(months => ({ value: String(months), label: `${months} meses` }))}
                  />
                </label>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  )
}
