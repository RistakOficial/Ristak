import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FlaskConical, Info, Plus } from 'lucide-react'
import { CustomSelect } from '../CustomSelect'
import { NumberInput } from '../NumberInput'
import { Switch } from '../Switch'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '../PaymentPlatformLogo'
import type { IntegrationsStatus } from '@/services/integrationsService'
import { useIntegrationsStatus } from '@/hooks/useIntegrationsStatus'
import { productsService, type ProductItem, type ProductPrice } from '@/services/productsService'
import { ProductFormModal } from '@/components/common/ProductFormModal/ProductFormModal'
import {
  CLIP_MSI_MIN_AMOUNT,
  STRIPE_MSI_MIN_AMOUNT,
  MSI_INSTALLMENT_CHOICES as SHARED_MSI_INSTALLMENT_CHOICES,
  SUBSCRIPTION_GATEWAYS as SHARED_SUBSCRIPTION_GATEWAYS,
  SUBSCRIPTION_INTERVAL_TYPES as SHARED_SUBSCRIPTION_INTERVAL_TYPES
} from '../../../../../shared/sites/paymentGateContract.js'
import styles from './PaymentGateControls.module.css'

export type PaymentGateGateway = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill'
export type PaymentGateBillingType = 'single' | 'subscription'
export type PaymentGateSubscriptionInterval = 'daily' | 'weekly' | 'monthly' | 'yearly'

// Modo por bloque SEGURO: solo puede forzar 'test' (probar sin cobrar aunque la
// plataforma esté en live). 'inherit' = usa el modo global. Nunca 'live' → imposible
// cobrar de verdad por accidente desde un bloque marcado como prueba.
export type PaymentGateMode = 'inherit' | 'test'

export interface PaymentGateMsi {
  enabled: boolean
  maxInstallments: number
}

export interface PaymentGateSubscriptionConfig {
  intervalType: PaymentGateSubscriptionInterval
  intervalCount: number
}

export interface PaymentGateConfig {
  enabled: boolean
  gateway: PaymentGateGateway
  billingType: PaymentGateBillingType
  amount: number
  currency: string
  productName: string
  description: string
  buttonText: string
  pendingMessage: string
  paidMessage: string
  mode: PaymentGateMode
  msi: PaymentGateMsi
  subscription: PaymentGateSubscriptionConfig
}

// Meses sin intereses: Stripe/CLIP los muestran dentro de su SDK, Mercado Pago
// dentro del Brick, Conekta usa selector propio y Rebill abre su checkout hospedado.
export const MSI_GATEWAYS = new Set<PaymentGateGateway>(['stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])
export const SUBSCRIPTION_GATEWAYS = new Set<PaymentGateGateway>(
  Array.from(SHARED_SUBSCRIPTION_GATEWAYS) as PaymentGateGateway[]
)
const SUBSCRIPTION_INTERVAL_TYPES = new Set<PaymentGateSubscriptionInterval>(
  Array.from(SHARED_SUBSCRIPTION_INTERVAL_TYPES) as PaymentGateSubscriptionInterval[]
)
// Lista de opciones en el contrato compartido para no divergir con el backend/runtime.
export const MSI_INSTALLMENT_CHOICES = SHARED_MSI_INSTALLMENT_CHOICES

interface PaymentGateControlsProps {
  value?: Partial<PaymentGateConfig> | null
  onChange: (nextConfig: PaymentGateConfig) => void
  onCommit?: () => void
  availableGateways?: PaymentGateGateway[]
  title?: string
  description?: string
  currencyFallback?: string
  requireConnectedGateway?: boolean
}

const gatewayOptions: Array<{ value: PaymentGateGateway; label: string; logo: PaymentPlatformLogoId }> = [
  { value: 'stripe', label: 'Stripe', logo: 'stripe' },
  { value: 'conekta', label: 'Conekta', logo: 'conekta' },
  { value: 'mercadopago', label: 'Mercado Pago', logo: 'mercadopago' },
  { value: 'clip', label: 'CLIP', logo: 'clip' },
  { value: 'rebill', label: 'Rebill', logo: 'rebill' }
]

const gatewayValues = new Set<PaymentGateGateway>(gatewayOptions.map(option => option.value))

const cleanText = (value: unknown, fallback = '') => String(value ?? fallback).trim()

// Texto libre en vivo: NO recorta (preserva espacios internos y finales mientras se
// escribe) y solo cae al fallback si el valor es null/undefined — así el usuario puede
// escribir "Mi Producto" sin que el espacio se borre a cada tecla. El backend recorta y
// aplica defaults al publicar (renderPaymentBlock), aquí priorizamos poder escribir.
const asText = (value: unknown, fallback = '') => (value === null || value === undefined ? fallback : String(value))

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

const normalizeBillingType = (value: unknown): PaymentGateBillingType =>
  cleanText(value).toLowerCase() === 'subscription' ? 'subscription' : 'single'

const normalizeMsi = (value: unknown): PaymentGateMsi => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<PaymentGateMsi> & { months?: number; max_installments?: number }
  const enabled = Boolean(source.enabled)
  const requested = Number(source.maxInstallments ?? source.max_installments ?? source.months ?? 0)
  if (!enabled || !Number.isFinite(requested) || requested <= 1) return { enabled: false, maxInstallments: 0 }
  const allowed = MSI_INSTALLMENT_CHOICES.filter(months => months <= requested)
  return { enabled: true, maxInstallments: allowed.length ? allowed[allowed.length - 1] : MSI_INSTALLMENT_CHOICES[0] }
}

const normalizeSubscriptionInterval = (value: unknown): PaymentGateSubscriptionInterval => {
  const interval = cleanText(value).toLowerCase() as PaymentGateSubscriptionInterval
  return SUBSCRIPTION_INTERVAL_TYPES.has(interval) ? interval : 'monthly'
}

const normalizeSubscription = (value: unknown): PaymentGateSubscriptionConfig => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<PaymentGateSubscriptionConfig> & {
    interval_type?: unknown
    interval_count?: unknown
    interval?: unknown
    every?: unknown
  }
  const count = Number.parseInt(String(source.intervalCount ?? source.interval_count ?? source.every ?? 1), 10)
  return {
    intervalType: normalizeSubscriptionInterval(source.intervalType ?? source.interval_type ?? source.interval),
    intervalCount: Number.isFinite(count) && count > 0 ? Math.min(24, count) : 1
  }
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
  const productName = asText(source.productName, 'Pago requerido')
  const gateway = normalizeGateway(source.gateway)
  const billingType = normalizeBillingType((source as { billingType?: unknown; billing_type?: unknown; type?: unknown }).billingType ?? (source as { billing_type?: unknown }).billing_type ?? (source as { type?: unknown }).type)

  return {
    enabled: Boolean(source.enabled),
    gateway,
    billingType: SUBSCRIPTION_GATEWAYS.has(gateway) ? billingType : 'single',
    amount: normalizeAmount(source.amount),
    currency: normalizeCurrency(source.currency, currencyFallback),
    productName,
    description: asText(source.description, productName),
    buttonText: asText(source.buttonText, 'Completar pago'),
    pendingMessage: asText(source.pendingMessage, 'Para continuar, completa el pago y deja esta página abierta.'),
    paidMessage: asText(source.paidMessage, 'Pago confirmado. Continuamos con tu solicitud.'),
    mode: normalizeMode(source.mode),
    msi: billingType === 'subscription' ? { enabled: false, maxInstallments: 0 } : normalizeMsi(source.msi ?? (source as { installments?: unknown }).installments),
    subscription: normalizeSubscription((source as { subscription?: unknown }).subscription)
  }
}

const isGatewayConnected = (status: IntegrationsStatus | null, gateway: PaymentGateGateway) => {
  if (!status) return false
  const gatewayStatus = gateway === 'stripe'
    ? status.stripe
    : gateway === 'conekta'
      ? status.conekta
      : gateway === 'mercadopago'
        ? status.mercadopago
        : gateway === 'clip'
          ? status.clip
          : status.rebill
  return Boolean(gatewayStatus?.connected || gatewayStatus?.configured)
}

export const PaymentGateControls: React.FC<PaymentGateControlsProps> = ({
  value,
  onChange,
  onCommit,
  availableGateways,
  title = 'Cobro requerido',
  description = 'La persona paga antes de avanzar.',
  currencyFallback = 'MXN',
  requireConnectedGateway = false
}) => {
  const { status: integrationsStatus } = useIntegrationsStatus()
  const allowedGatewayOptions = useMemo(() => {
    const requested = Array.isArray(availableGateways)
      ? availableGateways.filter(gateway => gatewayValues.has(gateway))
      : gatewayOptions.map(option => option.value)
    const requestedSet = new Set(requested)
    const filtered = gatewayOptions.filter(option => requestedSet.has(option.value))
    return filtered.length ? filtered : gatewayOptions
  }, [availableGateways])
  const allowedGatewayValues = useMemo(
    () => new Set<PaymentGateGateway>(allowedGatewayOptions.map(option => option.value)),
    [allowedGatewayOptions]
  )
  const gatewayConnectionIsKnown = integrationsStatus !== null
  const gatewayIsSelectable = useCallback((gateway: PaymentGateGateway) => (
    !requireConnectedGateway ||
    !gatewayConnectionIsKnown ||
    isGatewayConnected(integrationsStatus, gateway)
  ), [gatewayConnectionIsKnown, integrationsStatus, requireConnectedGateway])
  const hasSelectableGateway = useMemo(
    () => allowedGatewayOptions.some(option => gatewayIsSelectable(option.value)),
    [allowedGatewayOptions, gatewayIsSelectable]
  )
  const normalizeAllowedGateway = useCallback((gateway: unknown): PaymentGateGateway => {
    const normalized = normalizeGateway(gateway)
    if (allowedGatewayValues.has(normalized) && gatewayIsSelectable(normalized)) return normalized
    return (allowedGatewayOptions.find(option => gatewayIsSelectable(option.value)) || allowedGatewayOptions[0]).value
  }, [allowedGatewayOptions, allowedGatewayValues, gatewayIsSelectable])
  const normalizeAllowedPaymentGateConfig = useCallback((source?: Partial<PaymentGateConfig> | null) => {
    const normalized = normalizePaymentGateConfig(source, currencyFallback)
    const gateway = normalizeAllowedGateway(normalized.gateway)
    const billingType = SUBSCRIPTION_GATEWAYS.has(gateway) ? normalized.billingType : 'single'
    return {
      ...normalized,
      gateway,
      billingType,
      msi: billingType === 'single' && MSI_GATEWAYS.has(gateway) ? normalized.msi : { enabled: false, maxInstallments: 0 }
    }
  }, [currencyFallback, normalizeAllowedGateway])
  const config = useMemo(() => normalizeAllowedPaymentGateConfig(value), [normalizeAllowedPaymentGateConfig, value])
  const selectedGateway = allowedGatewayOptions.find(option => option.value === config.gateway) || allowedGatewayOptions[0]
  const clipControlsMsi = config.gateway === 'clip'
  const rebillControlsMsi = config.gateway === 'rebill'
  const gatewaySupportsSubscriptions = SUBSCRIPTION_GATEWAYS.has(config.gateway)
  const billingTypeOptions = gatewaySupportsSubscriptions
    ? [
        { value: 'single', label: 'Pago único' },
        { value: 'subscription', label: 'Suscripción' }
      ]
    : [{ value: 'single', label: 'Pago único' }]
  const intervalOptions = [
    { value: 'monthly', label: 'Mensual' },
    { value: 'yearly', label: 'Anual' },
    ...(config.gateway === 'rebill'
      ? []
      : [
          { value: 'weekly', label: 'Semanal' },
          ...(config.gateway === 'conekta' ? [] : [{ value: 'daily', label: 'Diaria' }])
        ])
  ]

  const patchConfig = (patch: Partial<PaymentGateConfig>) => {
    onChange(normalizeAllowedPaymentGateConfig({ ...config, ...patch }))
  }

  const commitSoon = () => {
    window.setTimeout(() => { onCommit?.() }, 0)
  }

  const enablePaymentGate = (enabled: boolean) => {
    if (enabled && !hasSelectableGateway) return

    patchConfig({
      enabled,
      amount: config.amount > 0 ? config.amount : 100,
      productName: config.productName || 'Pago requerido',
      description: config.description || config.productName || 'Pago requerido'
    })
    commitSoon()
  }

  // Catálogo opcional: sincroniza nombre + precio de un producto de la DB (editable).
  const [products, setProducts] = useState<ProductItem[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [productsError, setProductsError] = useState(false)
  const [selectedProductId, setSelectedProductId] = useState('')
  const [selectedPriceId, setSelectedPriceId] = useState('')
  const [createProductOpen, setCreateProductOpen] = useState(false)

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true)
    setProductsError(false)
    try {
      const result = await productsService.listProducts({ limit: 100, includePrices: true })
      setProducts(result.products)
      return result.products
    } catch {
      setProductsError(true)
      return [] as ProductItem[]
    } finally {
      setLoadingProducts(false)
    }
  }, [])

  useEffect(() => {
    if (!config.enabled) return
    void loadProducts()
  }, [config.enabled, loadProducts])

  const selectedProduct = useMemo(
    () => products.find(product => productKeyOf(product) === selectedProductId) || null,
    [products, selectedProductId]
  )
  const productPrices = selectedProduct?.prices || []

  const applyCatalogProduct = (id: string) => {
    setSelectedProductId(id)
    if (!id) {
      setSelectedPriceId('')
      return
    }
    const product = products.find(item => productKeyOf(item) === id)
    if (!product) return
    // Autoselecciona el primer precio (visible en el dropdown) y sincroniza el monto;
    // el usuario puede cambiar de precio o editar el monto a mano después.
    const firstPrice = (product.prices || [])[0]
    setSelectedPriceId(firstPrice ? priceKeyOf(firstPrice) : '')
    patchConfig({
      productName: product.name || config.productName,
      ...(firstPrice ? { amount: priceAmountOf(firstPrice) } : {})
    })
    window.setTimeout(() => { onCommit?.() }, 0)
  }

  const applyCatalogPrice = (key: string) => {
    setSelectedPriceId(key)
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
          disabled={!config.enabled && requireConnectedGateway && gatewayConnectionIsKnown && !hasSelectableGateway}
          aria-label={config.enabled ? 'Desactivar cobro requerido' : 'Activar cobro requerido'}
        />
      </div>

      {requireConnectedGateway && gatewayConnectionIsKnown && !hasSelectableGateway && (
        <p className={styles.testNote}>
          <Info size={15} />
          Conecta una pasarela de pago antes de activar este cobro.
        </p>
      )}

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
              <span>Pasarela</span>
              <CustomSelect
                value={config.gateway}
                onValueChange={(gateway) => {
                  const nextGateway = normalizeAllowedGateway(gateway)
                  patchConfig({
                    gateway: nextGateway,
                    billingType: SUBSCRIPTION_GATEWAYS.has(nextGateway) ? config.billingType : 'single'
                  })
                  commitSoon()
                }}
                onBlur={onCommit}
                options={allowedGatewayOptions.map(option => ({
                  value: option.value,
                  label: `${option.label} · ${isGatewayConnected(integrationsStatus, option.value) ? 'Conectado' : 'Sin conectar'}`,
                  disabled: requireConnectedGateway && gatewayConnectionIsKnown && !isGatewayConnected(integrationsStatus, option.value),
                  icon: <PaymentPlatformLogo platform={option.logo} size="sm" decorative className={styles.gatewayLogo} />
                }))}
              />
            </label>

            <label className={styles.field}>
              <span>Tipo de cobro</span>
              <CustomSelect
                value={config.billingType}
                onValueChange={(billingType) => {
                  patchConfig({
                    billingType: billingType === 'subscription' && gatewaySupportsSubscriptions ? 'subscription' : 'single'
                  })
                  commitSoon()
                }}
                onBlur={onCommit}
                options={billingTypeOptions}
              />
            </label>

            {config.gateway === 'clip' && (
              <p className={`${styles.testNote} ${styles.fieldWide}`}>
                <Info size={15} />
                CLIP solo está disponible para pagos únicos en Sites.
              </p>
            )}

            <div className={styles.field}>
              <div className={styles.catalogLabelRow}>
                <span title="Producto del catálogo">Catálogo</span>
                <button
                  type="button"
                  className={styles.catalogCreate}
                  onClick={() => setCreateProductOpen(true)}
                  title="Crear producto"
                >
                  <Plus size={13} />
                  Crear
                </button>
              </div>
              <CustomSelect
                value={selectedProductId}
                onValueChange={applyCatalogProduct}
                onBlur={onCommit}
                options={[
                  { value: '', label: loadingProducts ? 'Cargando…' : (productsError ? 'No se pudieron cargar' : 'Sin producto — captura manual') },
                  ...products.map(product => {
                    const firstPrice = (product.prices || [])[0]
                    const amount = firstPrice ? priceAmountOf(firstPrice) : 0
                    return {
                      value: productKeyOf(product),
                      label: amount > 0
                        ? `${product.name} · ${amount.toFixed(2)} ${firstPrice?.currency || config.currency}`
                        : product.name
                    }
                  })
                ]}
              />
            </div>

            <label className={styles.field}>
              <span>Concepto</span>
              <input
                value={config.productName}
                onChange={(event) => patchConfig({ productName: event.target.value })}
                onBlur={onCommit}
              />
            </label>

            {selectedProduct && (
              <div className={styles.field}>
                <span>Precio del producto</span>
                <CustomSelect
                  value={selectedPriceId}
                  onValueChange={applyCatalogPrice}
                  onBlur={onCommit}
                  disabled={productPrices.length === 0}
                  options={productPrices.length === 0
                    ? [{ value: '', label: 'Sin precios — escribe el monto' }]
                    : productPrices.map(price => ({
                        value: priceKeyOf(price),
                        label: `${price.name || 'Precio'} · ${priceAmountOf(price).toFixed(2)} ${price.currency || config.currency}`
                      }))}
                />
              </div>
            )}

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

            {config.billingType === 'subscription' && (
              <>
                <label className={styles.field}>
                  <span>Frecuencia</span>
                  <CustomSelect
                    value={config.subscription.intervalType}
                    onValueChange={(intervalType) => {
                      patchConfig({
                        subscription: {
                          ...config.subscription,
                          intervalType: normalizeSubscriptionInterval(intervalType)
                        }
                      })
                      commitSoon()
                    }}
                    onBlur={onCommit}
                    options={intervalOptions}
                  />
                </label>
                <label className={styles.field}>
                  <span>Repetir cada</span>
                  <NumberInput
                    value={config.subscription.intervalCount || 1}
                    min="1"
                    step="1"
                    onValueChange={(intervalCount) => patchConfig({
                      subscription: {
                        ...config.subscription,
                        intervalCount: Math.max(1, Math.trunc(Number(intervalCount) || 1))
                      }
                    })}
                    onBlur={onCommit}
                  />
                </label>
              </>
            )}

            {config.billingType === 'single' && MSI_GATEWAYS.has(config.gateway) && (
              <div className={`${styles.field} ${styles.fieldWide}`}>
                <div className={styles.toggleRow}>
                  <div className={styles.toggleCopy}>
                    <strong>Meses sin intereses</strong>
                    <span>
                      {clipControlsMsi
                        ? `CLIP muestra los plazos dentro de su formulario si la cuenta y tarjeta califican. Mínimo ${CLIP_MSI_MIN_AMOUNT} MXN.`
                        : rebillControlsMsi
                          ? 'Rebill abrirá su checkout seguro y mostrará hasta estos meses si la tarjeta aplica.'
                          : `Ofrece diferido a meses en ${selectedGateway.label}.`}
                    </span>
                  </div>
                  <Switch
                    checked={config.msi.enabled}
                    onChange={(enabled) => {
                      patchConfig({ msi: { enabled, maxInstallments: enabled ? (clipControlsMsi ? 24 : (config.msi.maxInstallments || 12)) : 0 } })
                      window.setTimeout(() => { onCommit?.() }, 0)
                    }}
                    aria-label={config.msi.enabled ? 'Desactivar meses sin intereses' : 'Activar meses sin intereses'}
                  />
                </div>
                {config.msi.enabled && !clipControlsMsi && (
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
                {config.gateway === 'stripe' && config.msi.enabled && Number(config.amount) < STRIPE_MSI_MIN_AMOUNT && (
                  <p className={styles.testNote}>
                    <Info size={15} />
                    Stripe requiere un monto mínimo de {STRIPE_MSI_MIN_AMOUNT} MXN para ofrecer meses sin intereses. Con {Number(config.amount) > 0 ? `$${config.amount}` : 'este monto'} se cobrará de contado.
                  </p>
                )}
              </div>
            )}

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

      <ProductFormModal
        isOpen={createProductOpen}
        onClose={() => setCreateProductOpen(false)}
        defaultCurrency={config.currency}
        onCreated={(product) => {
          setCreateProductOpen(false)
          const key = productKeyOf(product)
          void loadProducts().then((list) => {
            // Preferimos el producto ya listado (trae prices por includePrices) para
            // sincronizar el monto; si no aparece, caemos al que devolvió la creación.
            const fresh = list.find(item => productKeyOf(item) === key) || product
            setSelectedProductId(key)
            const firstPrice = (fresh.prices || [])[0]
            setSelectedPriceId(firstPrice ? priceKeyOf(firstPrice) : '')
            patchConfig({
              productName: fresh.name || config.productName,
              ...(firstPrice ? { amount: priceAmountOf(firstPrice) } : {})
            })
            window.setTimeout(() => { onCommit?.() }, 0)
          })
        }}
      />
    </div>
  )
}
