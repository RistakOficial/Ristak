import apiClient from './apiClient'

export interface ProductPrice {
  id?: string
  _id?: string
  localId?: string
  name?: string
  amount?: number
  price?: number
  currency?: string
  type?: string
  sku?: string | null
  syncStatus?: string
}

export interface ProductItem {
  id?: string
  _id?: string
  localId?: string
  ghlProductId?: string | null
  name: string
  description?: string
  currency?: string
  productType?: string
  source?: string
  syncStatus?: string
  syncError?: string | null
  gigstackProductKey?: string
  gigstackUnitKey?: string
  gigstackUnitName?: string
  postWebhooks?: ProductPostWebhook[]
  prices?: ProductPrice[]
}

export interface ProductPostWebhook {
  id?: string
  url: string
  authorization?: string
  headers?: Record<string, string>
  bodyMode?: 'fields' | 'json'
  bodyFields?: Array<{ key?: string; name?: string; value?: string }>
  body?: Record<string, unknown>
  enabled?: boolean
}

export interface ProductPayload {
  name: string
  description?: string
  currency?: string
  productType?: string
  gigstackProductKey?: string
  gigstackUnitKey?: string
  gigstackUnitName?: string
  postWebhooks?: ProductPostWebhook[]
  prices?: Array<{
    id?: string
    localId?: string
    name: string
    amount: number
    currency: string
    type: string
    sku?: string
  }>
}

interface ProductsResponse {
  products?: ProductItem[]
  total?: number
  summary?: ProductSummary
}

export interface ProductSummary {
  total: number
  totalPrices: number
  withSku: number
  withoutPrice: number
}

interface ProductMutationResponse {
  product?: ProductItem
  message?: string
}

const unwrapProduct = (response: ProductMutationResponse | ProductItem): ProductItem => {
  if (response && typeof response === 'object' && 'product' in response && response.product) {
    return response.product
  }

  return response as ProductItem
}

export const productsService = {
  async listProducts(params: {
    limit?: number
    offset?: number
    query?: string
    includePrices?: boolean
    sync?: boolean
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
  } = {}) {
    const data = await apiClient.get<ProductsResponse>('/products', {
      params: {
        limit: String(params.limit ?? 100),
        offset: String(params.offset ?? 0),
        includePrices: params.includePrices === false ? 'false' : 'true',
        ...(params.query ? { query: params.query } : {}),
        ...(params.sortBy ? { sortBy: params.sortBy } : {}),
        ...(params.sortOrder ? { sortOrder: params.sortOrder } : {}),
        ...(params.sync ? { sync: 'true' } : {})
      }
    })

    return {
      products: Array.isArray(data.products) ? data.products : [],
      total: data.total ?? data.products?.length ?? 0,
      summary: data.summary || {
        total: data.total ?? data.products?.length ?? 0,
        totalPrices: 0,
        withSku: 0,
        withoutPrice: 0
      }
    }
  },

  async createProduct(payload: ProductPayload) {
    const data = await apiClient.post<ProductMutationResponse | ProductItem>('/products', payload)
    return unwrapProduct(data)
  },

  async updateProduct(productId: string, payload: ProductPayload) {
    const data = await apiClient.put<ProductMutationResponse | ProductItem>(`/products/${encodeURIComponent(productId)}`, payload)
    return unwrapProduct(data)
  },

  async deleteProduct(productId: string) {
    await apiClient.delete(`/products/${encodeURIComponent(productId)}`)
  }
}
