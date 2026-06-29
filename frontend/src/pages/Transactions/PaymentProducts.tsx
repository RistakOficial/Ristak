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
  headersJson: string
}

type ProductTextFormField = Exclude<keyof ProductFormState, 'prices' | 'postWebhooks'>

const getProductId = (product: ProductItem) => product.localId || product.id || product._id || ''
const getPrimaryPrice = (product?: ProductItem | null) => product?.prices?.[0] || null
const getPriceId = (price?: ProductPrice | null) => price?.localId || price?.id || price?._id || ''
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

const stringifyHeaders = (headers?: Record<string, string>) => {
  if (!headers || Object.keys(headers).length === 0) return ''
  return JSON.stringify(headers, null, 2)
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
  headersJson: stringifyHeaders(webhook?.headers)
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

  const patchProductWebhook = (formId: string, field: keyof Pick<ProductWebhookFormState, 'url' | 'authorization' | 'headersJson'>, value: string) => {
    setProductForm((current) => ({
      ...current,
      postWebhooks: current.postWebhooks.map((webhook) => (
        webhook.formId === formId ? { ...webhook, [field]: value } : webhook
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

      if (!url && !authorization && !headersJson) continue
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
      if (headersJson) {
        try {
          const parsed = JSON.parse(headersJson)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('invalid_headers')
          }
          headers = Object.entries(parsed).reduce<Record<string, string>>((acc, [key, value]) => {
            const headerKey = key.trim()
            const headerValue = String(value ?? '').trim()
            if (headerKey && headerValue) acc[headerKey] = headerValue
            return acc
          }, {})
        } catch {
          showToast('warning', 'Headers inválidos', `Los headers del webhook ${index + 1} deben ser un JSON simple.`)
          return null
        }
      }

      webhooks.push({
        id: webhook.id || webhook.formId,
        url,
        ...(authorization ? { authorization } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {})
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
          size="lg"
          type="custom"
        >
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault()
            void handleSaveProduct()
          }}>
            <div className={styles.formGrid}>
              {editingProduct && getProductId(editingProduct) && (
                <div className={`${styles.productIdPanel} ${styles.fullWidth}`}>
                  <div className={styles.productIdValue}>
                    <span>ID del producto</span>
                    <code>{getProductId(editingProduct)}</code>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    leftIcon={<Copy size={14} />}
                    onClick={() => void handleCopyProductId(getProductId(editingProduct))}
                  >
                    Copiar
                  </Button>
                </div>
              )}

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
                  {productForm.prices.map((price, index) => (
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
                  ))}
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
                  onClick={() => setWebhooksExpanded((current) => !current)}
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
                                <label>Headers JSON</label>
                                <textarea
                                  rows={2}
                                  value={webhook.headersJson}
                                  onChange={(event) => patchProductWebhook(webhook.formId, 'headersJson', event.target.value)}
                                  placeholder='{"X-Secret": "valor"}'
                                />
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
