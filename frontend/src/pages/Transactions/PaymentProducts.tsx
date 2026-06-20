import React, { useEffect, useMemo, useState } from 'react'
import { Edit3, MoreVertical, Package, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
  Modal,
  NumberInput,
  PageContainer,
  PageHeader,
  Table
} from '@/components/common'
import type { BadgeVariant, Column } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { ACCOUNT_CURRENCY_CONFIG_KEY, CURRENCY_OPTIONS, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import { formatCurrency } from '@/utils/format'
import {
  productsService,
  type ProductItem,
  type ProductPayload,
  type ProductPrice
} from '@/services/productsService'
import styles from './PaymentProducts.module.css'

type ProductFormMode = 'create' | 'edit' | null

interface ProductFormState {
  name: string
  description: string
  priceName: string
  amount: string
  currency: string
}

const PRODUCT_CURRENCY_OPTIONS = CURRENCY_OPTIONS.map((option) => {
  const [code, description = code] = option.label.split(' - ')
  return { value: option.value, label: code, description }
})

const createEmptyProductForm = (currency = 'MXN'): ProductFormState => ({
  name: '',
  description: '',
  priceName: 'Precio base',
  amount: '',
  currency
})

const getProductId = (product: ProductItem) => product.localId || product.id || product._id || ''
const getPrimaryPrice = (product?: ProductItem | null) => product?.prices?.[0] || null
const getPriceId = (price?: ProductPrice | null) => price?.localId || price?.id || price?._id || ''
const getPriceAmount = (price?: ProductPrice | null) => Number(price?.amount ?? price?.price ?? 0) || 0

const getProductTypeLabel = (value?: string | null) => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'digital') return 'Digital'
  if (normalized === 'physical') return 'Físico'
  if (normalized === 'service') return 'Servicio'
  return value || 'Producto'
}

const getProductSourceLabel = (product: ProductItem) => (
  product.source === 'ghl' || product.ghlProductId ? 'HighLevel' : 'Ristak'
)

const getSyncStatusLabel = (status?: string | null) => {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'synced') return 'Sincronizado'
  if (normalized === 'pending') return 'Pendiente'
  if (normalized === 'error' || normalized === 'failed') return 'Error'
  if (normalized === 'deleted') return 'Eliminado'
  return status || 'Local'
}

const getSyncStatusVariant = (status?: string | null): BadgeVariant => {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'synced') return 'success'
  if (normalized === 'pending') return 'warning'
  if (normalized === 'error' || normalized === 'failed') return 'error'
  return 'neutral'
}

export const PaymentProducts: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const { connected: highLevelConnected } = useHighLevelConnected()
  const detectedLocaleDefaults = useMemo(getDetectedAccountLocaleDefaults, [])
  const [defaultCurrency] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
  const [products, setProducts] = useState<ProductItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<ProductFormMode>(null)
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null)
  const [productForm, setProductForm] = useState<ProductFormState>(() => createEmptyProductForm(defaultCurrency))

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

  const openCreateProduct = () => {
    setEditingProduct(null)
    setProductForm(createEmptyProductForm(defaultCurrency || 'MXN'))
    setFormMode('create')
  }

  const openEditProduct = (product: ProductItem) => {
    const price = getPrimaryPrice(product)

    setEditingProduct(product)
    setProductForm({
      name: product.name || '',
      description: product.description || '',
      priceName: price?.name || 'Precio base',
      amount: getPriceAmount(price) ? String(getPriceAmount(price)) : '',
      currency: price?.currency || product.currency || defaultCurrency || 'MXN'
    })
    setFormMode('edit')
  }

  const closeProductForm = () => {
    if (saving) return

    setFormMode(null)
    setEditingProduct(null)
    setProductForm(createEmptyProductForm(defaultCurrency || 'MXN'))
  }

  const patchProductForm = (field: keyof ProductFormState, value: string) => {
    setProductForm((current) => ({ ...current, [field]: value }))
  }

  const buildProductPayload = (): ProductPayload | null => {
    const name = productForm.name.trim()
    const amount = Number(productForm.amount)
    const currency = productForm.currency || defaultCurrency || 'MXN'

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama el producto.')
      return null
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('warning', 'Falta el precio', 'Escribe un precio válido para poder cobrarlo.')
      return null
    }

    const currentPrice = editingProduct ? getPrimaryPrice(editingProduct) : null

    return {
      name,
      description: productForm.description.trim(),
      currency,
      prices: [
        {
          id: getPriceId(currentPrice) || undefined,
          localId: currentPrice?.localId,
          name: productForm.priceName.trim() || 'Precio base',
          amount,
          currency,
          type: currentPrice?.type || 'one_time'
        }
      ]
    }
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
      } else {
        await productsService.createProduct(payload)
        showToast('success', 'Producto creado', `${payload.name} ya aparece en tu catálogo.`)
      }

      closeProductForm()
      await loadProducts({ refresh: true })
    } catch (error) {
      showToast('error', 'No se guardó el producto', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const deleteProduct = async (product: ProductItem) => {
    const productId = getProductId(product)
    if (!productId) return

    setDeletingProductId(productId)
    try {
      await productsService.deleteProduct(productId)
      setProducts((current) => current.filter((item) => getProductId(item) !== productId))
      if (editingProduct && getProductId(editingProduct) === productId) {
        closeProductForm()
      }
      showToast('success', 'Producto eliminado', `${product.name} ya no aparece para cobrar.`)
    } catch (error) {
      showToast('error', 'No se eliminó el producto', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setDeletingProductId(null)
    }
  }

  const handleDeleteProduct = (product: ProductItem) => {
    showConfirm(
      'Eliminar producto',
      `Se quitará "${product.name}" de la lista para cobrar. Los pagos anteriores no se borran.`,
      () => {
        void deleteProduct(product)
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
      header: 'Precio base',
      render: (_value, item) => {
        const price = getPrimaryPrice(item)
        const amount = getPriceAmount(price)
        const currency = price?.currency || item.currency || defaultCurrency || 'MXN'

        return amount > 0 ? (
          <span className={styles.priceCell}>{formatCurrency(amount, currency)}</span>
        ) : (
          <span className={styles.mutedCell}>Sin precio</span>
        )
      },
      searchValue: (_value, item) => {
        const price = getPrimaryPrice(item)
        return [getPriceAmount(price), price?.currency]
      },
      sortable: false
    },
    {
      key: 'productType',
      header: 'Tipo',
      render: (value) => <Badge variant="neutral">{getProductTypeLabel(value)}</Badge>,
      sortable: true
    },
    {
      key: 'source',
      header: 'Origen',
      render: (_value, item) => (
        <Badge variant={getProductSourceLabel(item) === 'HighLevel' ? 'info' : 'neutral'}>
          {getProductSourceLabel(item)}
        </Badge>
      ),
      sortable: true
    },
    {
      key: 'syncStatus',
      header: 'Estado',
      render: (value, item) => (
        <div className={styles.statusCell}>
          <Badge variant={getSyncStatusVariant(value)}>{getSyncStatusLabel(value)}</Badge>
          {item.syncError && <span className={styles.syncError}>{item.syncError}</span>}
        </div>
      ),
      sortable: true
    },
    {
      key: 'prices',
      header: 'Precios',
      render: (value) => Array.isArray(value) ? value.length : 0,
      sortable: false,
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
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={deleting}
                  onClick={() => handleDeleteProduct(item)}
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

  return (
    <PageContainer>
      <div className={styles.page}>
        <PageHeader
          title="Productos"
          subtitle="Administra los productos y precios guardados en la base de datos."
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => void loadProducts({ refresh: true, sync: highLevelConnected })}
                disabled={refreshing}
                leftIcon={<RefreshCw size={16} className={refreshing ? styles.spin : undefined} />}
              >
                {refreshing ? 'Actualizando...' : 'Actualizar'}
              </Button>
              <Button onClick={openCreateProduct} leftIcon={<Plus size={16} />}>
                Nuevo producto
              </Button>
            </>
          }
        />

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
            tableId="payment_products"
            initialSortBy="name"
            initialSortOrder="asc"
          />
        </Card>

        <Modal
          isOpen={formMode !== null}
          onClose={closeProductForm}
          title={formMode === 'edit' ? 'Editar producto' : 'Nuevo producto'}
          size="md"
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

              <div className={styles.formGroup}>
                <label>Nombre del precio</label>
                <input
                  value={productForm.priceName}
                  onChange={(event) => patchProductForm('priceName', event.target.value)}
                  placeholder="Precio base"
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label>Moneda</label>
                <CustomSelect
                  portal
                  dropdownMinWidth={280}
                  value={productForm.currency}
                  onChange={(event) => patchProductForm('currency', event.target.value)}
                >
                  {PRODUCT_CURRENCY_OPTIONS.map((currencyOption) => (
                    <option key={currencyOption.value} value={currencyOption.value}>
                      {currencyOption.label} - {currencyOption.description}
                    </option>
                  ))}
                </CustomSelect>
              </div>

              <div className={styles.formGroup}>
                <label>Monto</label>
                <NumberInput
                  value={productForm.amount}
                  onChange={(event) => patchProductForm('amount', event.target.value)}
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  required
                />
              </div>

              {editingProduct && (
                <div className={styles.formMeta}>
                  <Package size={16} />
                  <span>{getProductSourceLabel(editingProduct)} · {getSyncStatusLabel(editingProduct.syncStatus)}</span>
                </div>
              )}
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
