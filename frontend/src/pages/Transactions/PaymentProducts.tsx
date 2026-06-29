import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, Copy, DollarSign, Edit3, MoreVertical, Package, Plus, RefreshCw, Tag, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CustomSelect,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  KpiCard,
  Modal,
  NumberInput,
  PageContainer,
  PageHeader,
  PaymentPlatformLogo,
  Table,
  TableSelectionToolbar
} from '@/components/common'
import type { Column } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency, useHighLevelConnected } from '@/hooks'
import { formatCurrency } from '@/utils/format'
import {
  productsService,
  type ProductItem,
  type ProductPayload,
  type ProductPostWebhook,
  type ProductPrice
} from '@/services/productsService'
import { paymentSettingsService } from '@/services/paymentSettingsService'
import {
  getGigstackUnitName,
  gigstackProductKeyOptions,
  gigstackUnitOptions
} from '@/utils/gigstackFiscalCatalog'
import styles from './PaymentProducts.module.css'

type ProductFormMode = 'create' | 'edit' | null

interface ProductFormState {
  name: string
  description: string
  productType: string
  gigstackProductKey: string
  gigstackUnitKey: string
  postWebhooks: ProductWebhookFormState[]
  prices: ProductPriceFormState[]
}

interface ProductPriceFormState {
  formId: string
  id?: string
  localId?: string
  name: string
  amount: string
  sku: string
  type: string
}

interface ProductWebhookFormState {
  formId: string
  id?: string
  url: string
  authorization: string
  headersMode: 'fields' | 'json'
  headerRows: ProductWebhookHeaderFormState[]
  headersJson: string
  bodyMode: 'fields' | 'json'
  bodyRows: ProductWebhookBodyFormState[]
  bodyJson: string
}

interface ProductWebhookHeaderFormState {
  formId: string
  key: string
  value: string
}

interface ProductWebhookBodyFormState {
  formId: string
  key: string
  value: string
}

type ProductTextFormField = Exclude<keyof ProductFormState, 'prices' | 'postWebhooks'>

const getProductId = (product: ProductItem) => product.localId || product.id || product._id || ''
const getPrimaryPrice = (product?: ProductItem | null) => product?.prices?.[0] || null
const getPriceId = (price?: ProductPrice | null) => price?.localId || price?.id || price?._id || ''
const getPriceFormId = (price: ProductPriceFormState) => price.localId || price.id || ''
const getPriceAmount = (price?: ProductPrice | null) => Number(price?.amount ?? price?.price ?? 0) || 0

const productTypeOptions = [
  { value: 'digital', label: 'Producto digital' },
  { value: 'service', label: 'Servicio' },
  { value: 'physical', label: 'Producto físico' },
  { value: 'subscription', label: 'Membresía / suscripción' },
  { value: 'package', label: 'Paquete' }
]

const makePriceFormId = () => `price_${Math.random().toString(36).slice(2, 10)}`
const makeWebhookFormId = () => `webhook_${Math.random().toString(36).slice(2, 10)}`
const makeWebhookHeaderFormId = () => `header_${Math.random().toString(36).slice(2, 10)}`
const makeWebhookBodyFormId = () => `body_${Math.random().toString(36).slice(2, 10)}`

const stringifyHeaders = (headers?: Record<string, string>) => {
  if (!headers || Object.keys(headers).length === 0) return ''
  return JSON.stringify(headers, null, 2)
}

const stringifyBody = (body?: Record<string, unknown>) => {
  if (!body || Object.keys(body).length === 0) return ''
  return JSON.stringify(body, null, 2)
}

const createWebhookHeaderRows = (headers?: Record<string, string>): ProductWebhookHeaderFormState[] => (
  Object.entries(headers || {}).map(([key, value]) => ({
    formId: makeWebhookHeaderFormId(),
    key,
    value: String(value ?? '')
  }))
)

const headersFromRows = (rows: ProductWebhookHeaderFormState[]) => rows.reduce<Record<string, string>>((acc, row) => {
  const headerKey = row.key.trim()
  const headerValue = row.value.trim()
  if (headerKey && headerValue) acc[headerKey] = headerValue
  return acc
}, {})

const parseSimpleHeadersJson = (value: string): Record<string, string> => {
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_headers')
  }
  return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, headerValue]) => {
    const headerKey = key.trim()
    const cleanValue = String(headerValue ?? '').trim()
    if (headerKey && cleanValue) acc[headerKey] = cleanValue
    return acc
  }, {})
}

const createEmptyWebhookBodyRow = (): ProductWebhookBodyFormState => ({
  formId: makeWebhookBodyFormId(),
  key: '',
  value: ''
})

const isWebhookBodyFieldValue = (value: unknown) => (
  value === null || ['string', 'number', 'boolean'].includes(typeof value)
)

const createWebhookBodyRows = (
  bodyFields?: ProductPostWebhook['bodyFields'],
  body?: Record<string, unknown>
): ProductWebhookBodyFormState[] => {
  const fromFields = Array.isArray(bodyFields)
    ? bodyFields.map((row) => ({
        formId: makeWebhookBodyFormId(),
        key: String(row?.key || row?.name || ''),
        value: String(row?.value ?? '')
      })).filter((row) => row.key.trim() || row.value.trim())
    : []

  if (fromFields.length) return fromFields

  const fromBody = Object.entries(body || {})
    .filter(([, value]) => isWebhookBodyFieldValue(value))
    .map(([key, value]) => ({
      formId: makeWebhookBodyFormId(),
      key,
      value: String(value ?? '')
    }))

  return fromBody.length ? fromBody : [createEmptyWebhookBodyRow()]
}

const bodyFromRows = (rows: ProductWebhookBodyFormState[]) => rows.reduce<Record<string, string>>((acc, row) => {
  const fieldKey = row.key.trim()
  const fieldValue = row.value.trim()
  if (fieldKey && fieldValue) acc[fieldKey] = fieldValue
  return acc
}, {})

const parseSimpleBodyJson = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_body')
  }
  return parsed as Record<string, unknown>
}

const getWebhookBodyMode = (webhook?: ProductPostWebhook): 'fields' | 'json' => {
  if (webhook?.bodyMode === 'fields' || webhook?.bodyMode === 'json') return webhook.bodyMode
  const body = webhook?.body || {}
  return Object.values(body).some((value) => value !== null && typeof value === 'object') ? 'json' : 'fields'
}

const createProductPriceForm = (price?: ProductPrice | null, index = 0): ProductPriceFormState => {
  const amount = getPriceAmount(price)
  const priceId = getPriceId(price)

  return {
    formId: priceId || makePriceFormId(),
    id: price?.id || price?._id,
    localId: price?.localId,
    name: price?.name || (index === 0 ? 'Precio base' : `Precio ${index + 1}`),
    amount: amount > 0 ? String(amount) : '',
    sku: price?.sku || '',
    type: price?.type || 'one_time'
  }
}

const createProductWebhookForm = (webhook?: ProductPostWebhook): ProductWebhookFormState => ({
  formId: webhook?.id || makeWebhookFormId(),
  id: webhook?.id,
  url: webhook?.url || '',
  authorization: webhook?.authorization || '',
  headersMode: 'fields',
  headerRows: createWebhookHeaderRows(webhook?.headers),
  headersJson: stringifyHeaders(webhook?.headers),
  bodyMode: getWebhookBodyMode(webhook),
  bodyRows: createWebhookBodyRows(webhook?.bodyFields, webhook?.body),
  bodyJson: stringifyBody(webhook?.body)
})

const createEmptyProductForm = (): ProductFormState => ({
  name: '',
  description: '',
  productType: 'digital',
  gigstackProductKey: '',
  gigstackUnitKey: '',
  postWebhooks: [],
  prices: [createProductPriceForm(null, 0)]
})

const createProductFormFromProduct = (product: ProductItem): ProductFormState => {
  const prices = getProductPrices(product)

  return {
    name: product.name || '',
    description: product.description || '',
    productType: String(product.productType || 'digital').toLowerCase(),
    gigstackProductKey: product.gigstackProductKey || '',
    gigstackUnitKey: product.gigstackUnitKey || '',
    postWebhooks: Array.isArray(product.postWebhooks)
      ? product.postWebhooks.map(createProductWebhookForm)
      : [],
    prices: prices.length
      ? prices.map((price, index) => createProductPriceForm(price, index))
      : [createProductPriceForm(getPrimaryPrice(product), 0)]
  }
}

const copyTextToClipboard = async (text: string) => {
  const value = text.trim()
  if (!value) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }

    if (typeof document === 'undefined') return false

    const input = document.createElement('input')
    input.value = value
    input.setAttribute('readonly', 'true')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(input)
    return copied
  } catch {
    return false
  }
}

const getProductTypeLabel = (value?: string | null) => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'digital') return 'Digital'
  if (normalized === 'physical') return 'Físico'
  if (normalized === 'service') return 'Servicio'
  if (normalized === 'subscription') return 'Suscripción'
  if (normalized === 'package') return 'Paquete'
  return value || 'Producto'
}

const getProductPrices = (product: ProductItem) => Array.isArray(product.prices) ? product.prices : []

const getProductSkuSummary = (product: ProductItem) => {
  const skus = getProductPrices(product)
    .map((price) => String(price.sku || '').trim())
    .filter(Boolean)

  if (skus.length === 0) return 'Sin SKU'
  if (skus.length === 1) return skus[0]
  return `${skus[0]} +${skus.length - 1}`
}

const getProductSourceLabel = (product: ProductItem) => (
  product.source === 'ghl' || product.ghlProductId ? 'HighLevel' : 'Ristak'
)

export const PaymentProducts: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const { connected: highLevelConnected } = useHighLevelConnected()
  const [accountCurrency] = useAccountCurrency()
  const [products, setProducts] = useState<ProductItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [formMode, setFormMode] = useState<ProductFormMode>(null)
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null)
  const [productForm, setProductForm] = useState<ProductFormState>(() => createEmptyProductForm())
  const [webhooksExpanded, setWebhooksExpanded] = useState(false)
  const [gigstackProductMappingEnabled, setGigstackProductMappingEnabled] = useState(false)

  const loadProducts = async ({ refresh = false, sync = false }: { refresh?: boolean; sync?: boolean } = {}) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)

    try {
      const data = await productsService.listProducts({
        limit: 100,
        includePrices: true,
        sync
      })
      setProducts(data.products)
    } catch (error) {
      showToast('error', 'No se pudieron cargar los productos', error instanceof Error ? error.message : 'Intenta actualizar de nuevo.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadProducts()
  }, [])

  useEffect(() => {
    if (selectedProductIds.length === 0) return

    const availableProductIds = new Set(products.map(getProductId).filter(Boolean))
    const nextSelectedProductIds = selectedProductIds.filter((id) => availableProductIds.has(id))

    if (nextSelectedProductIds.length !== selectedProductIds.length) {
      setSelectedProductIds(nextSelectedProductIds)
    }
  }, [products, selectedProductIds])

  useEffect(() => {
    let cancelled = false

    paymentSettingsService.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setGigstackProductMappingEnabled(Boolean(settings.taxes?.enabled && settings.taxes?.gigstackEnabled))
        }
      })
      .catch(() => {
        if (!cancelled) setGigstackProductMappingEnabled(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const selectedProducts = useMemo(() => {
    if (selectedProductIds.length === 0) return []

    const selectedIds = new Set(selectedProductIds)
    return products.filter((product) => {
      const productId = getProductId(product)
      return Boolean(productId && selectedIds.has(productId))
    })
  }, [products, selectedProductIds])

  const productMetrics = useMemo(() => {
    return products.reduce((acc, product) => {
      const prices = getProductPrices(product)

      acc.total += 1
      acc.totalPrices += prices.length

      if (!prices.some((price) => getPriceAmount(price) > 0)) {
        acc.withoutPrice += 1
      }

      if (prices.some((price) => String(price.sku || '').trim())) {
        acc.withSku += 1
      }

      return acc
    }, {
      total: 0,
      withoutPrice: 0,
      totalPrices: 0,
      withSku: 0
    })
  }, [products])

  const openCreateProduct = () => {
    setEditingProduct(null)
    setProductForm(createEmptyProductForm())
    setWebhooksExpanded(false)
    setFormMode('create')
  }

  const openEditProduct = (product: ProductItem) => {
    setEditingProduct(product)
    setProductForm(createProductFormFromProduct(product))
    setWebhooksExpanded(false)
    setFormMode('edit')
  }

  const closeProductForm = () => {
    if (saving) return

    setFormMode(null)
    setEditingProduct(null)
    setProductForm(createEmptyProductForm())
    setWebhooksExpanded(false)
  }

  const patchProductForm = (field: ProductTextFormField, value: string) => {
    setProductForm((current) => ({ ...current, [field]: value }))
  }

  const patchProductPrice = (formId: string, field: keyof Pick<ProductPriceFormState, 'name' | 'amount' | 'sku'>, value: string) => {
    setProductForm((current) => ({
      ...current,
      prices: current.prices.map((price) => (
        price.formId === formId ? { ...price, [field]: value } : price
      ))
    }))
  }

  const addProductPrice = () => {
    setProductForm((current) => ({
      ...current,
      prices: [
        ...current.prices,
        createProductPriceForm(null, current.prices.length)
      ]
    }))
  }

  const removeProductPrice = (formId: string) => {
    setProductForm((current) => {
      if (current.prices.length <= 1) return current

      return {
        ...current,
        prices: current.prices.filter((price) => price.formId !== formId)
      }
    })
  }

  const patchProductWebhook = (
    formId: string,
    field: keyof Pick<ProductWebhookFormState, 'url' | 'authorization' | 'headersJson' | 'headersMode' | 'bodyJson' | 'bodyMode'>,
    value: string
  ) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === formId ? { ...webhook, [field]: value } : webhook
      ))
    }))
  }

  const setProductWebhookHeadersMode = (formId: string, mode: 'fields' | 'json') => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => {
        if (webhook.formId !== formId) return webhook

        if (mode === 'json') {
          const headers = headersFromRows(webhook.headerRows)
          return {
            ...webhook,
            headersMode: mode,
            headersJson: webhook.headersJson || stringifyHeaders(headers)
          }
        }

        if (webhook.headerRows.length > 0 || !webhook.headersJson.trim()) {
          return { ...webhook, headersMode: mode }
        }

        try {
          return {
            ...webhook,
            headersMode: mode,
            headerRows: createWebhookHeaderRows(parseSimpleHeadersJson(webhook.headersJson))
          }
        } catch {
          return { ...webhook, headersMode: mode }
        }
      })
    }))
  }

  const setProductWebhookBodyMode = (formId: string, mode: 'fields' | 'json') => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => {
        if (webhook.formId !== formId) return webhook

        if (mode === 'json') {
          const body = bodyFromRows(webhook.bodyRows)
          return {
            ...webhook,
            bodyMode: mode,
            bodyJson: webhook.bodyJson || stringifyBody(body)
          }
        }

        if (webhook.bodyRows.some((row) => row.key.trim() || row.value.trim()) || !webhook.bodyJson.trim()) {
          return { ...webhook, bodyMode: mode }
        }

        try {
          return {
            ...webhook,
            bodyMode: mode,
            bodyRows: createWebhookBodyRows(undefined, parseSimpleBodyJson(webhook.bodyJson))
          }
        } catch {
          return { ...webhook, bodyMode: mode }
        }
      })
    }))
  }

  const patchProductWebhookHeader = (
    webhookFormId: string,
    headerFormId: string,
    field: keyof Pick<ProductWebhookHeaderFormState, 'key' | 'value'>,
    value: string
  ) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              headerRows: webhook.headerRows.map((row) => (
                row.formId === headerFormId ? { ...row, [field]: value } : row
              ))
            }
          : webhook
      ))
    }))
  }

  const patchProductWebhookBody = (
    webhookFormId: string,
    bodyFormId: string,
    field: keyof Pick<ProductWebhookBodyFormState, 'key' | 'value'>,
    value: string
  ) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              bodyRows: webhook.bodyRows.map((row) => (
                row.formId === bodyFormId ? { ...row, [field]: value } : row
              ))
            }
          : webhook
      ))
    }))
  }

  const addProductWebhookHeader = (webhookFormId: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              headersMode: 'fields',
              headerRows: [
                ...webhook.headerRows,
                { formId: makeWebhookHeaderFormId(), key: '', value: '' }
              ]
            }
          : webhook
      ))
    }))
  }

  const addProductWebhookBodyField = (webhookFormId: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              bodyMode: 'fields',
              bodyRows: [
                ...webhook.bodyRows,
                createEmptyWebhookBodyRow()
              ]
            }
          : webhook
      ))
    }))
  }

  const removeProductWebhookHeader = (webhookFormId: string, headerFormId: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              headerRows: webhook.headerRows.filter((row) => row.formId !== headerFormId)
            }
          : webhook
      ))
    }))
  }

  const removeProductWebhookBodyField = (webhookFormId: string, bodyFormId: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === webhookFormId
          ? {
              ...webhook,
              bodyRows: webhook.bodyRows.filter((row) => row.formId !== bodyFormId)
            }
          : webhook
      ))
    }))
  }

  const addProductWebhook = () => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: [
        ...current.postWebhooks,
        createProductWebhookForm()
      ]
    }))
    setWebhooksExpanded(true)
  }

  const toggleProductWebhooks = () => {
    if (!webhooksExpanded) {
      setProductForm((current) => (
        current.postWebhooks.length > 0
          ? current
          : {
              ...current,
              postWebhooks: [createProductWebhookForm()]
            }
      ))
    }

    setWebhooksExpanded((current) => !current)
  }

  const removeProductWebhook = (formId: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.filter((webhook) => webhook.formId !== formId)
    }))
  }

  const buildPostWebhooksPayload = (): ProductPostWebhook[] | null => {
    const webhooks: ProductPostWebhook[] = []

    for (const [index, webhook] of productForm.postWebhooks.entries()) {
      const url = webhook.url.trim()
      const authorization = webhook.authorization.trim()
      const headersJson = webhook.headersJson.trim()
      const bodyJson = webhook.bodyJson.trim()
      const headersFromFields = headersFromRows(webhook.headerRows)
      const bodyFromFields = bodyFromRows(webhook.bodyRows)
      const hasIncompleteHeaderRow = webhook.headersMode === 'fields' && webhook.headerRows.some((row) => {
        const hasKey = Boolean(row.key.trim())
        const hasValue = Boolean(row.value.trim())
        return hasKey !== hasValue
      })
      const hasIncompleteBodyRow = webhook.bodyMode === 'fields' && webhook.bodyRows.some((row) => {
        const hasKey = Boolean(row.key.trim())
        const hasValue = Boolean(row.value.trim())
        return hasKey !== hasValue
      })
      const hasHeaders = webhook.headersMode === 'json'
        ? Boolean(headersJson)
        : Object.keys(headersFromFields).length > 0
      const hasBody = webhook.bodyMode === 'json'
        ? Boolean(bodyJson)
        : Object.keys(bodyFromFields).length > 0

      if (hasIncompleteHeaderRow) {
        showToast('warning', 'Header incompleto', `Completa nombre y valor en los headers del webhook ${index + 1}.`)
        return null
      }

      if (hasIncompleteBodyRow) {
        showToast('warning', 'Body incompleto', `Completa nombre y valor en el body del webhook ${index + 1}.`)
        return null
      }

      if (!url && !authorization && !hasHeaders && !hasBody) continue
      if (!url) {
        showToast('warning', 'Falta la URL del webhook', `Agrega una ruta POST para el webhook ${index + 1}.`)
        return null
      }

      try {
        const parsedUrl = new URL(url)
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error('invalid_protocol')
        }
      } catch {
        showToast('warning', 'URL inválida', `Revisa la ruta POST del webhook ${index + 1}.`)
        return null
      }

      let headers: Record<string, string> | undefined
      if (webhook.headersMode === 'json' && headersJson) {
        try {
          headers = parseSimpleHeadersJson(headersJson)
        } catch {
          showToast('warning', 'Headers inválidos', `Los headers del webhook ${index + 1} deben ser un JSON simple.`)
          return null
        }
      } else if (webhook.headersMode === 'fields') {
        headers = headersFromFields
      }

      let body: Record<string, unknown> | undefined
      let bodyFields: Array<{ key: string; value: string }> | undefined
      if (webhook.bodyMode === 'json' && bodyJson) {
        try {
          body = parseSimpleBodyJson(bodyJson)
        } catch {
          showToast('warning', 'Body inválido', `El body del webhook ${index + 1} debe ser un JSON simple.`)
          return null
        }
      } else if (webhook.bodyMode === 'fields') {
        body = bodyFromFields
        bodyFields = webhook.bodyRows
          .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
          .filter((row) => row.key && row.value)
      }

      webhooks.push({
        id: webhook.id || webhook.formId,
        url,
        ...(authorization ? { authorization } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(body && Object.keys(body).length
          ? {
              bodyMode: webhook.bodyMode,
              ...(bodyFields?.length ? { bodyFields } : {}),
              body
            }
          : {})
      })
    }

    return webhooks
  }

  const buildProductPayload = (): ProductPayload | null => {
    const name = productForm.name.trim()
    const currency = accountCurrency
    const prices = productForm.prices.map((price, index) => ({
      ...price,
      name: price.name.trim() || (index === 0 ? 'Precio base' : `Precio ${index + 1}`),
      amount: Number(price.amount),
      sku: price.sku.trim()
    }))

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama el producto.')
      return null
    }

    if (prices.length === 0) {
      showToast('warning', 'Falta el precio', 'Agrega al menos un precio para poder cobrar este producto.')
      return null
    }

    const invalidPrice = prices.find((price) => !Number.isFinite(price.amount) || price.amount <= 0)
    if (invalidPrice) {
      showToast('warning', 'Falta el precio', 'Escribe un precio válido para poder cobrarlo.')
      return null
    }

    const postWebhooks = buildPostWebhooksPayload()
    if (!postWebhooks) return null

    return {
      name,
      description: productForm.description.trim(),
      currency,
      productType: productForm.productType,
      gigstackProductKey: productForm.gigstackProductKey,
      gigstackUnitKey: productForm.gigstackUnitKey,
      gigstackUnitName: getGigstackUnitName(productForm.gigstackUnitKey),
      postWebhooks,
      prices: prices.map((price) => ({
        id: price.id || undefined,
        localId: price.localId,
        name: price.name,
        amount: price.amount,
        currency,
        type: price.type || 'one_time',
        ...(price.sku ? { sku: price.sku } : {})
      }))
    }
  }

  const handleCopyProductId = async (productId: string) => {
    const copied = await copyTextToClipboard(productId)

    if (copied) {
      showToast('success', 'ID copiado', 'Ya puedes pegar el ID del producto donde lo necesites.')
      return
    }

    showToast('error', 'No se pudo copiar', 'Selecciona el ID y cópialo manualmente.')
  }

  const handleCopyPriceId = async (priceId: string) => {
    const copied = await copyTextToClipboard(priceId)

    if (copied) {
      showToast('success', 'ID copiado', 'Ya puedes pegar el ID del precio donde lo necesites.')
      return
    }

    showToast('error', 'No se pudo copiar', 'Selecciona el ID del precio y cópialo manualmente.')
  }

  const handleSaveProduct = async () => {
    const payload = buildProductPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (formMode === 'edit' && editingProduct) {
        const productId = getProductId(editingProduct)
        if (!productId) throw new Error('No se encontró el ID del producto.')

        await productsService.updateProduct(productId, payload)
        showToast('success', 'Producto actualizado', `${payload.name} ya quedó listo para cobrar.`)
        closeProductForm()
      } else {
        const createdProduct = await productsService.createProduct(payload)
        const createdProductId = getProductId(createdProduct)

        setEditingProduct(createdProduct)
        setProductForm(createProductFormFromProduct(createdProduct))
        setFormMode('edit')
        showToast(
          'success',
          'Producto creado',
          createdProductId
            ? `Ya aparece en tu catálogo y su ID quedó listo para copiar.`
            : `${payload.name} ya aparece en tu catálogo.`
        )
      }

      await loadProducts({ refresh: true })
    } catch (error) {
      showToast('error', 'No se guardó el producto', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const deleteProducts = async (targetProducts: ProductItem[]) => {
    const productsToDelete = targetProducts
      .map((product) => ({ product, productId: getProductId(product) }))
      .filter((entry): entry is { product: ProductItem; productId: string } => Boolean(entry.productId))

    if (productsToDelete.length === 0) return

    const failedProducts: ProductItem[] = []
    const deletedIds: string[] = []
    try {
      for (const { product, productId } of productsToDelete) {
        setDeletingProductId(productId)
        try {
          await productsService.deleteProduct(productId)
          deletedIds.push(productId)
        } catch {
          failedProducts.push(product)
        }
      }

      if (deletedIds.length > 0) {
        const deletedIdSet = new Set(deletedIds)
        setProducts((current) => current.filter((item) => !deletedIdSet.has(getProductId(item))))
        setSelectedProductIds((current) => current.filter((id) => !deletedIdSet.has(id)))
      }

      if (editingProduct && deletedIds.includes(getProductId(editingProduct))) {
        closeProductForm()
      }

      if (failedProducts.length > 0) {
        showToast(
          'error',
          'No se pudieron eliminar todos',
          `Se eliminaron ${deletedIds.length} y fallaron ${failedProducts.length}. Revisa los pendientes e intenta otra vez.`
        )
        return
      }

      showToast(
        'success',
        productsToDelete.length === 1 ? 'Producto eliminado' : 'Productos eliminados',
        productsToDelete.length === 1
          ? `${productsToDelete[0].product.name} ya no aparece para cobrar.`
          : `Se eliminaron ${productsToDelete.length} productos correctamente.`
      )
    } finally {
      setDeletingProductId(null)
    }
  }

  const handleDeleteProducts = (targetProducts: ProductItem[]) => {
    if (targetProducts.length === 0) return

    const isSingleProduct = targetProducts.length === 1
    const firstProduct = targetProducts[0]
    if (!firstProduct) return

    showConfirm(
      isSingleProduct ? 'Eliminar producto' : 'Eliminar productos',
      isSingleProduct
        ? `Se quitará "${firstProduct.name}" de la lista para cobrar. Los pagos anteriores no se borran. Esta acción no se puede deshacer.`
        : `Vas a eliminar ${targetProducts.length} productos del catálogo para cobrar. Los pagos anteriores no se borran. Esta acción no se puede deshacer.`,
      async () => {
        await deleteProducts(targetProducts)
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const columns: Column<ProductItem>[] = [
    {
      key: 'name',
      header: 'Producto',
      render: (_value, item) => (
        <button
          type="button"
          className={styles.nameButton}
          onClick={(event) => {
            event.stopPropagation()
            openEditProduct(item)
          }}
        >
          <span>{item.name || 'Producto sin nombre'}</span>
          {item.description && <small>{item.description}</small>}
        </button>
      ),
      sortable: true
    },
    {
      key: 'price',
      header: 'Precios',
      render: (_value, item) => {
        const prices = getProductPrices(item)
        const pricedItems = prices.filter((price) => getPriceAmount(price) > 0)
        const primaryPrice = pricedItems[0] || getPrimaryPrice(item)
        const amount = getPriceAmount(primaryPrice)
        const currency = primaryPrice?.currency || item.currency || accountCurrency

        return amount > 0 ? (
          <span className={styles.priceStack}>
            <span className={styles.priceCell}>{formatCurrency(amount, currency)}</span>
            {prices.length > 1 && <small>{prices.length} precios</small>}
          </span>
        ) : (
          <span className={styles.mutedCell}>Sin precio</span>
        )
      },
      searchValue: (_value, item) => {
        return getProductPrices(item).flatMap((price) => [
          price.name,
          price.sku,
          getPriceAmount(price),
          price.currency
        ])
      },
      sortable: false
    },
    {
      key: 'sku',
      header: 'SKU',
      render: (_value, item) => {
        const summary = getProductSkuSummary(item)
        return summary === 'Sin SKU'
          ? <span className={styles.mutedCell}>Sin SKU</span>
          : <span className={styles.skuCell}>{summary}</span>
      },
      searchValue: (_value, item) => getProductPrices(item).map((price) => price.sku),
      sortable: false
    },
    {
      key: 'productType',
      header: 'Categoría',
      render: (value) => <Badge variant="neutral">{getProductTypeLabel(value)}</Badge>,
      sortable: true
    },
    ...(gigstackProductMappingEnabled ? [{
      key: 'gigstackProductKey',
      header: (
        <span className={styles.fiscalHeader}>
          <PaymentPlatformLogo platform="gigstack" size="sm" decorative />
          <span>Facturación</span>
        </span>
      ),
      render: (_value, item) => item.gigstackProductKey ? (
        <div className={styles.fiscalCell}>
          <Badge variant="info">{item.gigstackProductKey}</Badge>
          <span>{item.gigstackUnitKey || 'Sin unidad'}</span>
        </div>
      ) : (
        <span className={styles.mutedCell}>Usa default</span>
      ),
      sortable: false
    } satisfies Column<ProductItem>] : []),
    {
      key: 'source',
      header: 'Origen',
      render: (_value, item) => (
        <Badge variant={getProductSourceLabel(item) === 'HighLevel' ? 'info' : 'neutral'}>
          {getProductSourceLabel(item)}
        </Badge>
      ),
      sortable: true,
      visible: false
    },
    {
      key: 'actions',
      header: 'Acciones',
      render: (_value, item) => {
        const productId = getProductId(item)
        const deleting = deletingProductId === productId

        return (
          <div className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Acciones del producto"
                  disabled={deleting}
                >
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={deleting} onClick={() => openEditProduct(item)}>
                  <Edit3 size={16} />
                  <span>Editar producto</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={deleting || !productId}
                  onClick={() => void handleCopyProductId(productId)}
                >
                  <Copy size={16} />
                  <span>Copiar ID</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={deleting}
                  onClick={() => handleDeleteProducts([item])}
                  className={styles.destructive}
                >
                  <Trash2 size={16} />
                  <span>Eliminar producto</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
      sortable: false,
      fixed: true,
      width: '88px'
    }
  ]

  const productSelectionToolbar = selectedProducts.length > 0 ? (
    <TableSelectionToolbar
      count={selectedProducts.length}
      onClearSelection={() => setSelectedProductIds([])}
    >
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={Boolean(deletingProductId)}
        onClick={() => handleDeleteProducts(selectedProducts)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null
  const editingProductId = editingProduct ? getProductId(editingProduct) : ''

  return (
    <PageContainer>
      <div className={styles.page}>
        <PageHeader
          title="Productos"
          subtitle="Administra los productos, precios e impuestos guardados en la base de datos."
          actions={
            <>
              <Button onClick={openCreateProduct} leftIcon={<Plus size={16} />}>
                Nuevo producto
              </Button>
              <Button
                type="button"
                variant="secondary"
                iconOnly
                aria-label="Actualizar productos"
                title="Actualizar productos"
                onClick={() => void loadProducts({ refresh: true, sync: highLevelConnected })}
                disabled={refreshing}
                leftIcon={<RefreshCw size={16} className={refreshing ? styles.spin : undefined} />}
              />
            </>
          }
        />

        <div className={styles.metricsGrid}>
          <KpiCard title="Productos" value={productMetrics.total} icon={Package} loading={loading} />
          <KpiCard title="Precios" value={productMetrics.totalPrices} icon={DollarSign} loading={loading} />
          <KpiCard title="Con SKU" value={productMetrics.withSku} icon={Tag} loading={loading} />
          <KpiCard title="Sin precio" value={productMetrics.withoutPrice} icon={AlertTriangle} loading={loading} />
        </div>

        <Card padding="none">
          <Table
            key="payment_products_table"
            initialColumns={columns}
            data={products}
            keyExtractor={(item) => getProductId(item) || item.name}
            onRowClick={openEditProduct}
            emptyMessage="No hay productos guardados"
            loading={loading}
            searchable={true}
            searchPlaceholder="Buscar productos..."
            paginated={true}
            pageSize={20}
            searchPosition="left"
            tableId="payment_products_catalog"
            initialSortBy="name"
            initialSortOrder="asc"
            selectionActions={productSelectionToolbar}
            rowSelection={{
              selectedKeys: selectedProductIds,
              onChange: setSelectedProductIds,
              isRowDisabled: (item) => !getProductId(item),
              getRowLabel: (item) => item.name || 'producto',
              selectVisibleLabel: 'Seleccionar productos visibles'
            }}
          />
        </Card>

        <Modal
          isOpen={formMode !== null}
          onClose={closeProductForm}
          title={formMode === 'edit' ? 'Editar producto' : 'Nuevo producto'}
          subtitle={editingProductId ? (
            <span className={styles.modalIdLine}>
              <span>ID del producto</span>
              <code>{editingProductId}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Copiar ID del producto"
                title="Copiar ID del producto"
                leftIcon={<Copy size={13} />}
                onClick={() => void handleCopyProductId(editingProductId)}
              />
            </span>
          ) : undefined}
          size="lg"
          type="custom"
        >
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault()
            void handleSaveProduct()
          }}>
            <div className={styles.formGrid}>
              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label>Nombre del producto</label>
                <input
                  value={productForm.name}
                  onChange={(event) => patchProductForm('name', event.target.value)}
                  placeholder="Mensualidad, consulta, paquete..."
                  required
                />
              </div>

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label>Descripción</label>
                <textarea
                  rows={3}
                  value={productForm.description}
                  onChange={(event) => patchProductForm('description', event.target.value)}
                  placeholder="Detalle visible para el equipo y para cobros."
                />
              </div>

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label>Categoría</label>
                <CustomSelect
                  value={productForm.productType}
                  onValueChange={(value) => patchProductForm('productType', value)}
                  options={productTypeOptions}
                />
              </div>

              <div className={`${styles.pricesPanel} ${styles.fullWidth}`}>
                <div className={styles.sectionHeader}>
                  <span>Precios</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    leftIcon={<Plus size={14} />}
                    onClick={addProductPrice}
                  >
                    Agregar precio
                  </Button>
                </div>

                <div className={styles.priceList}>
                  {productForm.prices.map((price, index) => {
                    const priceId = getPriceFormId(price)

                    return (
                      <div className={styles.priceRow} key={price.formId}>
                        <div className={styles.priceIndex}>
                          {index + 1}
                        </div>

                        <div className={styles.priceFields}>
                          <div className={styles.formGroup}>
                            <label>Nombre del precio</label>
                            <input
                              value={price.name}
                              onChange={(event) => patchProductPrice(price.formId, 'name', event.target.value)}
                              placeholder={index === 0 ? 'Precio base' : `Precio ${index + 1}`}
                              required
                            />
                          </div>

                          <div className={styles.formGroup}>
                            <label>Monto ({accountCurrency})</label>
                            <NumberInput
                              value={price.amount}
                              onChange={(event) => patchProductPrice(price.formId, 'amount', event.target.value)}
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              required
                            />
                          </div>

                          <div className={styles.formGroup}>
                            <label>SKU</label>
                            <input
                              value={price.sku}
                              onChange={(event) => patchProductPrice(price.formId, 'sku', event.target.value)}
                              placeholder="SKU-001"
                            />
                          </div>

                          {priceId && (
                            <div className={styles.priceIdLine}>
                              <span>ID del precio</span>
                              <code>{priceId}</code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                iconOnly
                                aria-label="Copiar ID del precio"
                                title="Copiar ID del precio"
                                leftIcon={<Copy size={13} />}
                                onClick={() => void handleCopyPriceId(priceId)}
                              />
                            </div>
                          )}
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label="Quitar precio"
                          title="Quitar precio"
                          disabled={productForm.prices.length <= 1}
                          leftIcon={<Trash2 size={16} />}
                          onClick={() => removeProductPrice(price.formId)}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>

              {gigstackProductMappingEnabled && (
                <div className={`${styles.fiscalPanel} ${styles.fullWidth}`}>
                  <div className={styles.fiscalPanelHeader}>
                    <span className={styles.fiscalTitle}>
                      <PaymentPlatformLogo platform="gigstack" size="sm" decorative />
                      <span>Facturación e impuestos</span>
                    </span>
                    <Badge variant={productForm.gigstackProductKey ? 'success' : 'neutral'}>
                      {productForm.gigstackProductKey ? 'Mapeado' : 'Default'}
                    </Badge>
                  </div>
                  <div className={styles.fiscalGrid}>
                    <div className={styles.formGroup}>
                      <label>Categoría SAT para facturas</label>
                      <CustomSelect
                        value={productForm.gigstackProductKey}
                        onValueChange={(value) => patchProductForm('gigstackProductKey', value)}
                        options={[
                          { value: '', label: 'Usar default de Gigstack' },
                          ...gigstackProductKeyOptions
                        ]}
                      />
                    </div>
                    <div className={styles.formGroup}>
                      <label>Unidad fiscal</label>
                      <CustomSelect
                        value={productForm.gigstackUnitKey}
                        onValueChange={(value) => patchProductForm('gigstackUnitKey', value)}
                        options={[
                          { value: '', label: 'Usar default de Gigstack' },
                          ...gigstackUnitOptions
                        ]}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className={`${styles.webhookSection} ${styles.fullWidth}`}>
                <button
                  type="button"
                  className={styles.webhookToggle}
                  onClick={toggleProductWebhooks}
                  aria-expanded={webhooksExpanded}
                >
                  <span>Webhooks</span>
                  <ChevronDown
                    size={14}
                    className={webhooksExpanded ? styles.webhookToggleIconOpen : styles.webhookToggleIcon}
                  />
                </button>

                {webhooksExpanded && (
                  <div className={styles.webhookBody}>
                    {productForm.postWebhooks.length > 0 && (
                      <div className={styles.webhookList}>
                        {productForm.postWebhooks.map((webhook, index) => (
                          <div className={styles.webhookRow} key={webhook.formId}>
                            <div className={styles.webhookIndex}>{index + 1}</div>
                            <div className={styles.webhookFields}>
                              <div className={`${styles.formGroup} ${styles.webhookUrlField}`}>
                                <label>Ruta POST</label>
                                <input
                                  value={webhook.url}
                                  onChange={(event) => patchProductWebhook(webhook.formId, 'url', event.target.value)}
                                  placeholder="https://api.tuapp.com/webhooks/ristak"
                                />
                              </div>
                              <div className={styles.formGroup}>
                                <label>Authorization / contraseña</label>
                                <input
                                  value={webhook.authorization}
                                  onChange={(event) => patchProductWebhook(webhook.formId, 'authorization', event.target.value)}
                                  placeholder="Bearer token..."
                                />
                              </div>
                              <div className={`${styles.formGroup} ${styles.webhookHeadersField}`}>
                                <div className={styles.webhookHeadersHeader}>
                                  <label>Headers</label>
                                  <CustomSelect
                                    value={webhook.headersMode}
                                    onValueChange={(value) => setProductWebhookHeadersMode(
                                      webhook.formId,
                                      value === 'json' ? 'json' : 'fields'
                                    )}
                                    options={[
                                      { value: 'fields', label: 'Campos' },
                                      { value: 'json', label: 'JSON' }
                                    ]}
                                  />
                                </div>

                                {webhook.headersMode === 'json' ? (
                                  <textarea
                                    rows={2}
                                    value={webhook.headersJson}
                                    onChange={(event) => patchProductWebhook(webhook.formId, 'headersJson', event.target.value)}
                                    placeholder='{"X-Secret": "valor"}'
                                  />
                                ) : (
                                  <div className={styles.webhookHeadersList}>
                                    {webhook.headerRows.map((header) => (
                                      <div className={styles.webhookHeaderRow} key={header.formId}>
                                        <input
                                          value={header.key}
                                          onChange={(event) => patchProductWebhookHeader(
                                            webhook.formId,
                                            header.formId,
                                            'key',
                                            event.target.value
                                          )}
                                          placeholder="Nombre"
                                        />
                                        <input
                                          value={header.value}
                                          onChange={(event) => patchProductWebhookHeader(
                                            webhook.formId,
                                            header.formId,
                                            'value',
                                            event.target.value
                                          )}
                                          placeholder="Valor"
                                        />
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          iconOnly
                                          aria-label="Quitar header"
                                          title="Quitar header"
                                          leftIcon={<Trash2 size={14} />}
                                          onClick={() => removeProductWebhookHeader(webhook.formId, header.formId)}
                                        />
                                      </div>
                                    ))}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      leftIcon={<Plus size={14} />}
                                      onClick={() => addProductWebhookHeader(webhook.formId)}
                                    >
                                      Agregar header
                                    </Button>
                                  </div>
                                )}
                              </div>
                              <div className={`${styles.formGroup} ${styles.webhookHeadersField}`}>
                                <div className={styles.webhookHeadersHeader}>
                                  <label>Body</label>
                                  <CustomSelect
                                    value={webhook.bodyMode}
                                    onValueChange={(value) => setProductWebhookBodyMode(
                                      webhook.formId,
                                      value === 'json' ? 'json' : 'fields'
                                    )}
                                    options={[
                                      { value: 'fields', label: 'Campos' },
                                      { value: 'json', label: 'JSON' }
                                    ]}
                                  />
                                </div>

                                {webhook.bodyMode === 'json' ? (
                                  <textarea
                                    rows={3}
                                    value={webhook.bodyJson}
                                    onChange={(event) => patchProductWebhook(webhook.formId, 'bodyJson', event.target.value)}
                                    placeholder='{"campaign": "lanzamiento"}'
                                  />
                                ) : (
                                  <div className={styles.webhookHeadersList}>
                                    {webhook.bodyRows.map((bodyField) => (
                                      <div className={styles.webhookHeaderRow} key={bodyField.formId}>
                                        <input
                                          value={bodyField.key}
                                          onChange={(event) => patchProductWebhookBody(
                                            webhook.formId,
                                            bodyField.formId,
                                            'key',
                                            event.target.value
                                          )}
                                          placeholder="Nombre"
                                        />
                                        <input
                                          value={bodyField.value}
                                          onChange={(event) => patchProductWebhookBody(
                                            webhook.formId,
                                            bodyField.formId,
                                            'value',
                                            event.target.value
                                          )}
                                          placeholder="Valor"
                                        />
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          iconOnly
                                          aria-label="Quitar campo del body"
                                          title="Quitar campo del body"
                                          leftIcon={<Trash2 size={14} />}
                                          onClick={() => removeProductWebhookBodyField(webhook.formId, bodyField.formId)}
                                        />
                                      </div>
                                    ))}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      leftIcon={<Plus size={14} />}
                                      onClick={() => addProductWebhookBodyField(webhook.formId)}
                                    >
                                      Agregar campo
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              iconOnly
                              aria-label="Quitar webhook"
                              title="Quitar webhook"
                              leftIcon={<Trash2 size={16} />}
                              onClick={() => removeProductWebhook(webhook.formId)}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      leftIcon={<Plus size={14} />}
                      onClick={addProductWebhook}
                    >
                      Agregar webhook
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className={styles.modalFooter}>
              <Button type="button" variant="ghost" onClick={closeProductForm} disabled={saving}>
                Cancelar
              </Button>
              <Button type="submit" loading={saving}>
                {formMode === 'edit' ? 'Guardar producto' : 'Crear producto'}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </PageContainer>
  )
}
