import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, CreditCard, Loader2, MonitorX, Package, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { RecordPaymentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected, usePhoneElasticScroll } from '@/hooks'
import apiClient from '@/services/apiClient'
import { getPhoneDailyCacheKey, readPhoneDailyCache, writePhoneDailyCache } from '@/services/phoneDailyCache'
import { transactionsService, type Transaction } from '@/services/transactionsService'
import { ACCOUNT_CURRENCY_CONFIG_KEY, CURRENCY_OPTIONS, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import styles from './PhonePayments.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_PHONE_SELECTOR = '[data-phone-scrollable="true"], [data-phone-chat-scrollable="true"]'

type AccessState = 'checking' | 'allowed' | 'blocked'
type PaymentView = 'select' | 'single' | 'partial' | 'products'
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d'
type ProductFormMode = 'create' | 'edit' | null

interface ProductPrice {
  id?: string
  _id?: string
  localId?: string
  name?: string
  amount?: number
  price?: number
  currency?: string
}

interface ProductItem {
  id?: string
  _id?: string
  localId?: string
  name: string
  description?: string
  currency?: string
  productType?: string
  source?: string
  syncStatus?: string
  syncError?: string | null
  prices?: ProductPrice[]
}

interface ProductFormState {
  name: string
  description: string
  priceName: string
  amount: string
  currency: string
}

const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'partial'])

const RECENT_PAYMENT_PERIODS: Array<{ id: RecentPaymentsPeriod; label: string; days: number }> = [
  { id: 'today', label: 'Hoy', days: 0 },
  { id: '7d', label: '7 días', days: 7 },
  { id: '30d', label: '30 días', days: 30 },
  { id: '90d', label: '90 días', days: 90 }
]

const PRODUCT_CURRENCY_OPTIONS = CURRENCY_OPTIONS.map((option) => {
  const [code, description = code] = option.label.split(' - ')
  return { value: option.value, label: code, description }
})

function hasPortableAccess() {
  if (typeof window === 'undefined') return false

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const phoneViewport = window.matchMedia(PHONE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return phoneViewport || (portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer))
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

function getInitialView(mode: string | null): PaymentView {
  if (mode === 'single' || mode === 'partial' || mode === 'products') return mode
  return 'select'
}

function formatISODate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getRecentPaymentRange(period: RecentPaymentsPeriod) {
  const end = new Date()
  const start = new Date()
  const selectedPeriod = RECENT_PAYMENT_PERIODS.find((option) => option.id === period) || RECENT_PAYMENT_PERIODS[2]

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)

  if (selectedPeriod.days > 0) {
    start.setDate(start.getDate() - (selectedPeriod.days - 1))
  }

  return {
    startDate: formatISODate(start),
    endDate: formatISODate(end)
  }
}

function formatCurrency(value: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(value || 0)
}

function formatPaymentDate(value?: string | null) {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function getPaymentMethodLabel(method?: string | null) {
  const normalizedMethod = String(method || '').toLowerCase()
  if (normalizedMethod === 'card') return 'Tarjeta'
  if (normalizedMethod === 'transfer' || normalizedMethod === 'bank_transfer') return 'Transferencia'
  if (normalizedMethod === 'cash') return 'Efectivo'
  if (normalizedMethod === 'check') return 'Cheque'
  if (normalizedMethod === 'paypal') return 'PayPal'
  return 'Otro'
}

function getPaymentStatusLabel(status?: string | null) {
  const normalizedStatus = String(status || '').toLowerCase()
  if (normalizedStatus === 'paid') return 'Pagado'
  if (normalizedStatus === 'partial') return 'Parcial'
  if (normalizedStatus === 'refunded') return 'Reembolsado'
  if (normalizedStatus === 'failed') return 'Fallido'
  if (normalizedStatus === 'pending') return 'Pendiente'
  return status || 'Sin estado'
}

function getContactLabel(transaction: Transaction) {
  return transaction.contactName || transaction.email || transaction.phone || 'Cliente sin nombre'
}

function getProductId(product: ProductItem) {
  return product.localId || product.id || product._id || ''
}

function getPriceId(price?: ProductPrice | null) {
  return price?.localId || price?.id || price?._id || ''
}

function getPrimaryPrice(product?: ProductItem | null) {
  return product?.prices?.[0] || null
}

function getPriceAmount(price?: ProductPrice | null) {
  return Number(price?.amount ?? price?.price ?? 0) || 0
}

function createEmptyProductForm(currency = 'MXN'): ProductFormState {
  return {
    name: '',
    description: '',
    priceName: 'Precio base',
    amount: '',
    currency
  }
}

export const PhonePayments: React.FC = () => {
  const [searchParams] = useSearchParams()
  const { connected: highLevelConnected } = useHighLevelConnected()
  const { showConfirm, showToast } = useNotification()
  const detectedLocaleDefaults = getDetectedAccountLocaleDefaults()
  const [defaultCurrency] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  usePhoneElasticScroll({ enabled: accessState === 'allowed' })

  const [view, setView] = useState<PaymentView>(() => getInitialView(searchParams.get('mode')))
  const [recentPaymentsOpen, setRecentPaymentsOpen] = useState(false)
  const [recentPaymentsPeriod, setRecentPaymentsPeriod] = useState<RecentPaymentsPeriod>('30d')
  const [recentPayments, setRecentPayments] = useState<Transaction[]>([])
  const [recentPaymentsLoading, setRecentPaymentsLoading] = useState(false)
  const [recentPaymentsRefreshing, setRecentPaymentsRefreshing] = useState(false)
  const [selectedRecentPaymentId, setSelectedRecentPaymentId] = useState<string | null>(null)
  const [products, setProducts] = useState<ProductItem[]>([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [productsRefreshing, setProductsRefreshing] = useState(false)
  const [productsError, setProductsError] = useState('')
  const [productFormMode, setProductFormMode] = useState<ProductFormMode>(null)
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null)
  const [productForm, setProductForm] = useState<ProductFormState>(() => createEmptyProductForm(defaultCurrency))
  const [savingProduct, setSavingProduct] = useState(false)
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null)

  const loadProducts = async ({ refresh = false }: { refresh?: boolean } = {}) => {
    if (refresh) {
      setProductsRefreshing(true)
    } else {
      setProductsLoading(true)
    }
    setProductsError('')

    try {
      const data = await apiClient.get<{ products?: ProductItem[]; total?: number }>('/products', {
        params: {
          limit: '100',
          includePrices: 'true'
        }
      })
      setProducts(Array.isArray(data.products) ? data.products : [])
    } catch (error: any) {
      const message = error?.message || 'No se pudieron cargar los productos.'
      setProductsError(message)
      showToast('error', 'No se cargaron los productos', message)
    } finally {
      setProductsLoading(false)
      setProductsRefreshing(false)
    }
  }

  const openCreateProduct = () => {
    setEditingProduct(null)
    setProductForm(createEmptyProductForm(defaultCurrency))
    setProductFormMode('create')
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
    setProductFormMode('edit')
  }

  const closeProductForm = () => {
    setProductFormMode(null)
    setEditingProduct(null)
    setProductForm(createEmptyProductForm(defaultCurrency))
  }

  const updateProductForm = (field: keyof ProductFormState, value: string) => {
    setProductForm((current) => ({ ...current, [field]: value }))
  }

  const handleSaveProduct = async () => {
    const name = productForm.name.trim()
    const amount = Number(productForm.amount)
    const currency = productForm.currency || defaultCurrency || 'MXN'

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama el producto.')
      return
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('warning', 'Falta el precio', 'Escribe un precio válido para poder cobrarlo.')
      return
    }

    const currentPrice = editingProduct ? getPrimaryPrice(editingProduct) : null
    const payload = {
      name,
      description: productForm.description.trim(),
      currency,
      prices: [
        {
          id: getPriceId(currentPrice),
          localId: currentPrice?.localId,
          name: productForm.priceName.trim() || 'Precio base',
          amount,
          currency,
          type: 'one_time'
        }
      ]
    }

    setSavingProduct(true)
    try {
      if (productFormMode === 'edit' && editingProduct) {
        await apiClient.put(`/products/${getProductId(editingProduct)}`, payload)
        showToast('success', 'Producto actualizado', `${name} ya quedó listo para cobrar.`)
      } else {
        await apiClient.post('/products', payload)
        showToast('success', 'Producto creado', `${name} ya aparece en tu catálogo.`)
      }

      closeProductForm()
      await loadProducts({ refresh: true })
    } catch (error: any) {
      showToast('error', 'No se guardó el producto', error?.message || 'Intenta otra vez.')
    } finally {
      setSavingProduct(false)
    }
  }

  const confirmDeleteProduct = async (product: ProductItem) => {
    const productId = getProductId(product)
    if (!productId) return

    setDeletingProductId(productId)
    try {
      await apiClient.delete(`/products/${productId}`)
      setProducts((current) => current.filter((item) => getProductId(item) !== productId))
      if (editingProduct && getProductId(editingProduct) === productId) {
        closeProductForm()
      }
      showToast('success', 'Producto eliminado', `${product.name} ya no aparece para cobrar.`)
    } catch (error: any) {
      showToast('error', 'No se eliminó', error?.message || 'Intenta otra vez.')
    } finally {
      setDeletingProductId(null)
    }
  }

  const handleDeleteProduct = (product: ProductItem) => {
    showConfirm(
      'Eliminar producto',
      `Se quitará "${product.name}" de la lista para cobrar. Los pagos anteriores no se borran.`,
      () => {
        void confirmDeleteProduct(product)
      },
      'Eliminar',
      'Cancelar'
    )
  }

  useEffect(() => {
    document.title = 'Pagos móviles | Ristak'
  }, [])

  useEffect(() => {
    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const phoneMedia = window.matchMedia(PHONE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    phoneMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      phoneMedia.removeEventListener('change', updateAccess)
      pointerMedia.removeEventListener('change', updateAccess)
      window.removeEventListener('resize', updateAccess)
      window.removeEventListener('orientationchange', updateAccess)
      window.visualViewport?.removeEventListener('resize', updateAccess)
    }
  }, [])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const html = document.documentElement
    const body = document.body
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const previousViewportContent = viewportMeta?.getAttribute('content') || ''
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousHtmlBackground = html.style.background
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousBodyBackground = body.style.background
    const phoneFrameBackground = 'color-mix(in srgb, var(--color-background-primary) 92%, #ffffff 8%)'
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.background = phoneFrameBackground
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.background = phoneFrameBackground

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const handleTouchStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY || 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      const scrollable = getScrollableElement(event.target)

      if (!scrollable) {
        event.preventDefault()
        return
      }

      const currentY = event.touches[0]?.clientY || startY
      const deltaY = currentY - startY
      const canScroll = scrollable.scrollHeight > scrollable.clientHeight + 1
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

      if (!canScroll || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        event.preventDefault()
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)

      if (viewportMeta) {
        viewportMeta.setAttribute('content', previousViewportContent)
      }

      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      html.style.background = previousHtmlBackground
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
      body.style.background = previousBodyBackground
    }
  }, [accessState])

  useEffect(() => {
    if (accessState !== 'allowed' || !recentPaymentsOpen) return

    let cancelled = false
    const loadRecentPayments = async () => {
      const { startDate, endDate } = getRecentPaymentRange(recentPaymentsPeriod)
      const cacheKey = getPhoneDailyCacheKey('phone-payments', 'recent-payments', recentPaymentsPeriod, startDate, endDate)
      const cachedPayments = readPhoneDailyCache<Transaction[]>(cacheKey)
      const showedCachedPayments = Boolean(cachedPayments)

      if (cachedPayments) {
        const cachedList = Array.isArray(cachedPayments.data) ? cachedPayments.data : []
        setRecentPayments(cachedList)
        setSelectedRecentPaymentId((current) => (
          current && cachedList.some((payment) => payment.id === current) ? current : null
        ))
        setRecentPaymentsLoading(false)
        setRecentPaymentsRefreshing(true)
      } else {
        setRecentPaymentsLoading(true)
        setRecentPaymentsRefreshing(false)
      }

      try {
        const transactions = await transactionsService.getTransactions(startDate, endDate)

        if (cancelled) return

        const receivedPayments = transactions
          .filter((transaction) => transaction.amount > 0 && SUCCESS_PAYMENT_STATUSES.has(String(transaction.status || '').toLowerCase()))
          .sort((left, right) => Date.parse(right.date || right.createdAt || '') - Date.parse(left.date || left.createdAt || ''))

        setRecentPayments(receivedPayments)
        setSelectedRecentPaymentId((current) => (
          current && receivedPayments.some((payment) => payment.id === current) ? current : null
        ))
        writePhoneDailyCache(cacheKey, receivedPayments.slice(0, 80), { maxEntryChars: 260_000 })
      } catch {
        if (!cancelled && !showedCachedPayments) {
          setRecentPayments([])
          setSelectedRecentPaymentId(null)
        }
      } finally {
        if (!cancelled) {
          setRecentPaymentsLoading(false)
          setRecentPaymentsRefreshing(false)
        }
      }
    }

    loadRecentPayments()

    return () => {
      cancelled = true
    }
  }, [accessState, recentPaymentsOpen, recentPaymentsPeriod])

  useEffect(() => {
    if (highLevelConnected || view !== 'partial') return
    setView('single')
  }, [highLevelConnected, view])

  useEffect(() => {
    if (accessState !== 'allowed' || view !== 'products') return
    loadProducts()
  }, [accessState, view])

  const renderProductsView = () => (
    <section className={styles.productsHost} data-phone-scrollable="true" aria-label="Precios Guardados disponibles">
      <div className={styles.productsToolbar}>
        <div className={styles.productsToolbarCopy}>
          <strong>Precios Guardados</strong>
          <small>{products.length === 1 ? '1 disponible' : `${products.length} disponibles`}</small>
        </div>
        <div className={styles.productsToolbarActions}>
          <button
            type="button"
            className={styles.productIconButton}
            onClick={() => loadProducts({ refresh: true })}
            disabled={productsLoading || productsRefreshing}
            aria-label="Actualizar productos"
          >
            <RefreshCw size={18} className={productsRefreshing ? styles.spinIcon : ''} />
          </button>
          <button
            type="button"
            className={styles.productPrimaryButton}
            onClick={openCreateProduct}
            disabled={savingProduct}
          >
            <Plus size={17} />
            Nuevo
          </button>
        </div>
      </div>

      {productFormMode && (
        <form
          className={styles.productForm}
          onSubmit={(event) => {
            event.preventDefault()
            void handleSaveProduct()
          }}
        >
          <div className={styles.productFormHeader}>
            <div>
              <strong>{productFormMode === 'edit' ? 'Editar producto' : 'Nuevo producto'}</strong>
              <small>Estos datos aparecerán al cobrar desde productos guardados.</small>
            </div>
            <button type="button" onClick={closeProductForm} aria-label="Cerrar formulario">
              <X size={18} />
            </button>
          </div>

          <label className={styles.productField}>
            <span>Nombre del producto</span>
            <input
              value={productForm.name}
              onChange={(event) => updateProductForm('name', event.target.value)}
              placeholder="Ej. Consulta inicial"
            />
          </label>

          <div className={styles.productFormGrid}>
            <label className={styles.productField}>
              <span>Precio</span>
              <input
                value={productForm.amount}
                onChange={(event) => updateProductForm('amount', event.target.value)}
                inputMode="decimal"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
              />
            </label>
            <label className={styles.productField}>
              <span>Moneda</span>
              <PhoneSelect
                value={productForm.currency}
                onChange={(value) => updateProductForm('currency', value)}
                options={PRODUCT_CURRENCY_OPTIONS}
                title="Moneda"
                placeholder="Moneda"
                buttonClassName={styles.productSelectButton}
              />
            </label>
          </div>

          <label className={styles.productField}>
            <span>Nombre del precio</span>
            <input
              value={productForm.priceName}
              onChange={(event) => updateProductForm('priceName', event.target.value)}
              placeholder="Precio base"
            />
          </label>

          <label className={styles.productField}>
            <span>Descripción</span>
            <textarea
              value={productForm.description}
              onChange={(event) => updateProductForm('description', event.target.value)}
              placeholder="Agrega una nota corta para reconocerlo."
              rows={3}
            />
          </label>

          <div className={styles.productFormActions}>
            <button type="button" className={styles.productSecondaryButton} onClick={closeProductForm} disabled={savingProduct}>
              Cancelar
            </button>
            <button type="submit" className={styles.productPrimaryButton} disabled={savingProduct}>
              {savingProduct ? <Loader2 size={17} className={styles.spinIcon} /> : <Save size={17} />}
              Guardar
            </button>
          </div>
        </form>
      )}

      {productsLoading && products.length === 0 ? (
        <div className={styles.productsState}>
          <Loader2 size={18} className={styles.spinIcon} />
          Cargando productos...
        </div>
      ) : productsError && products.length === 0 ? (
        <div className={styles.productsState}>
          <strong>No se pudieron cargar</strong>
          <span>{productsError}</span>
        </div>
      ) : products.length === 0 ? (
        <div className={styles.productsEmpty}>
          <Package size={28} />
          <strong>Sin productos todavía</strong>
          <span>Crea tu primer producto para cobrarlo rápido desde el celular.</span>
          <button type="button" className={styles.productPrimaryButton} onClick={openCreateProduct}>
            <Plus size={17} />
            Crear producto
          </button>
        </div>
      ) : (
        <div className={styles.productsList}>
          {products.map((product) => {
            const productId = getProductId(product)
            const price = getPrimaryPrice(product)
            const deleting = deletingProductId === productId

            return (
              <article key={productId || product.name} className={styles.productItem}>
                <div className={styles.productItemMain}>
                  <div className={styles.productItemIcon}>
                    <Package size={20} />
                  </div>
                  <div className={styles.productItemCopy}>
                    <strong>{product.name || 'Producto sin nombre'}</strong>
                    <span>{product.description || 'Sin descripción'}</span>
                    <small>{price ? `${price.name || 'Precio'} · ${formatCurrency(getPriceAmount(price), price.currency || product.currency || defaultCurrency || 'MXN')}` : 'Sin precio guardado'}</small>
                  </div>
                </div>
                <div className={styles.productItemActions}>
                  <button type="button" onClick={() => openEditProduct(product)} aria-label={`Editar ${product.name}`}>
                    <Pencil size={17} />
                  </button>
                  <button
                    type="button"
                    className={styles.productDeleteButton}
                    onClick={() => handleDeleteProduct(product)}
                    disabled={deleting}
                    aria-label={`Eliminar ${product.name}`}
                  >
                    {deleting ? <Loader2 size={17} className={styles.spinIcon} /> : <Trash2 size={17} />}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )

  if (accessState === 'checking') {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.loadingDot} />
      </main>
    )
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-payments-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Ruta móvil</p>
            <h1 id="phone-payments-blocked-title">Solo celular o tablet</h1>
            <p>
              Esta pantalla está hecha para cobrar desde celular o tablet. Ábrela desde un dispositivo portátil para cobrarle a tus clientes.
            </p>
          </div>
          <Link className={styles.dashboardLink} to="/transactions">
            Ir a pagos
          </Link>
        </section>
      </main>
    )
  }

  const isForm = view !== 'select'
  const isPaymentForm = view === 'single' || view === 'partial'
  const formMode = view === 'partial' ? 'partial' : 'single'
  const formTitle = view === 'products' ? 'Precios Guardados' : view === 'partial' ? 'Plan de pago' : 'Registrar pago'
  const selectedRecentPeriod = RECENT_PAYMENT_PERIODS.find((period) => period.id === recentPaymentsPeriod) || RECENT_PAYMENT_PERIODS[2]
  const selectedRecentPayment = recentPayments.find((payment) => payment.id === selectedRecentPaymentId) || null

  return (
    <main className={styles.phonePage} aria-label="Pagos móviles de Ristak">
      <PhonePageTransition active="payments" className={styles.phoneFrame}>
        {isForm && (
          <header className={styles.header}>
            <button
              type="button"
              className={styles.backButton}
              onClick={() => setView('select')}
            >
              <ArrowLeft size={18} />
              <span>Atrás</span>
            </button>
            <h2 className={styles.headerFormTitle}>{formTitle}</h2>
          </header>
        )}

        {isPaymentForm ? (
          <div className={styles.formHost} data-phone-scrollable="true">
            <RecordPaymentModal
              key={formMode}
              variant="embedded"
              isOpen
              initialPaymentMode={formMode}
              onClose={() => setView('select')}
              onSuccess={() => setView('select')}
            />
          </div>
        ) : view === 'products' ? (
          renderProductsView()
        ) : (
          <section className={styles.selectStack} aria-label="Elige el tipo de pago" data-phone-scrollable="true">
            <h1 className={styles.selectTitle}>Elige cómo quieres pagar</h1>

            <button
              type="button"
              className={styles.choiceCard}
              onClick={() => setView('single')}
            >
              <span className={`${styles.choiceIcon} ${styles.choiceIconGreen}`}>
                <CreditCard size={26} />
              </span>
              <span className={styles.choiceText}>
                <strong>Registrar pago</strong>
                <small>Cobro único: envía una liga de pago o registra un pago manual.</small>
              </span>
              <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
            </button>

            {highLevelConnected && (
              <button
                type="button"
                className={styles.choiceCard}
                onClick={() => setView('partial')}
              >
                <span className={`${styles.choiceIcon} ${styles.choiceIconBlue}`}>
                  <CalendarDays size={26} />
                </span>
                <span className={styles.choiceText}>
                  <strong>Planes de pago</strong>
                  <small>Parcialidades automáticas con enganche y cobros recurrentes.</small>
                </span>
                <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className={`${styles.choiceCard} ${styles.choiceCardNoDivider}`}
              onClick={() => setView('products')}
            >
              <span className={`${styles.choiceIcon} ${styles.choiceIconBlue}`}>
                <Package size={26} />
              </span>
              <span className={styles.choiceText}>
                <strong>Precios Guardados</strong>
                <small>Revisa, crea, modifica o elimina precios para cobrarlos desde el celular.</small>
              </span>
              <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
            </button>

            <section className={styles.recentPaymentsSection} aria-label="Últimos pagos recibidos">
              <button
                type="button"
                className={styles.recentPaymentsToggle}
                onClick={() => setRecentPaymentsOpen((open) => !open)}
                aria-expanded={recentPaymentsOpen}
              >
                <span>
                  <strong>{recentPaymentsOpen ? 'Ocultar últimos pagos' : 'Mostrar últimos pagos'}</strong>
                  <small>
                    {selectedRecentPayment
                      ? `${formatCurrency(selectedRecentPayment.amount, selectedRecentPayment.currency || defaultCurrency || 'MXN')} seleccionado`
                      : `${selectedRecentPeriod.label} recientes`}
                  </small>
                </span>
                <ChevronDown className={recentPaymentsOpen ? styles.recentPaymentsChevronOpen : ''} size={22} />
              </button>

              {recentPaymentsOpen && (
                <div className={styles.recentPaymentsPanel}>
                  <div className={styles.recentPeriodPicker} role="group" aria-label="Periodo de últimos pagos">
                    {RECENT_PAYMENT_PERIODS.map((period) => (
                      <button
                        key={period.id}
                        type="button"
                        className={period.id === recentPaymentsPeriod ? styles.recentPeriodActive : ''}
                        onClick={() => setRecentPaymentsPeriod(period.id)}
                      >
                        {period.label}
                      </button>
                    ))}
                  </div>

                  {recentPaymentsLoading && recentPayments.length === 0 ? (
                    <div className={styles.recentPaymentsState}>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Cargando pagos...
                    </div>
                  ) : recentPayments.length === 0 ? (
                    <div className={styles.recentPaymentsState}>
                      {recentPaymentsRefreshing && (
                        <span className={styles.recentPaymentsRefresh}>
                          <Loader2 size={16} className={styles.spinIcon} />
                          Actualizando pagos
                        </span>
                      )}
                      No hay pagos recibidos en este periodo.
                    </div>
                  ) : (
                    <>
                      {recentPaymentsRefreshing && (
                        <div className={styles.recentPaymentsRefresh} role="status">
                          <Loader2 size={16} className={styles.spinIcon} />
                          Mostrando lo guardado, actualizando pagos
                        </div>
                      )}
                      <div className={styles.recentPaymentsList}>
                        {recentPayments.slice(0, 24).map((payment) => {
                          const selected = selectedRecentPaymentId === payment.id
                          return (
                            <button
                              key={payment.id}
                              type="button"
                              className={`${styles.recentPaymentItem} ${selected ? styles.recentPaymentItemSelected : ''}`}
                              onClick={() => setSelectedRecentPaymentId(selected ? null : payment.id)}
                            >
                              <span className={styles.recentPaymentMain}>
                                <strong>{formatCurrency(payment.amount, payment.currency || defaultCurrency || 'MXN')}</strong>
                                <small>{getContactLabel(payment)}</small>
                              </span>
                              <span className={styles.recentPaymentMeta}>
                                <span>{formatPaymentDate(payment.date || payment.createdAt)}</span>
                                <small>{getPaymentMethodLabel(payment.method)} · {getPaymentStatusLabel(payment.status)}</small>
                              </span>
                              {selected && <Check size={18} className={styles.recentPaymentCheck} aria-hidden="true" />}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          </section>
        )}
      </PhonePageTransition>
      <PhoneEcosystemNav active="payments" />
    </main>
  )
}
