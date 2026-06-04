import { randomUUID } from 'crypto'
import { db, getHighLevelConfig } from '../config/database.js'
import GHLClient from './ghlClient.js'
import { logger } from '../utils/logger.js'

const LOCAL_PRODUCT_PREFIX = 'rstk_prod'
const LOCAL_PRICE_PREFIX = 'rstk_price'
const DEFAULT_CURRENCY = 'MXN'
const DEFAULT_PRODUCT_TYPE = 'DIGITAL'
const DEFAULT_PRICE_TYPE = 'one_time'
const PRODUCT_PAGE_LIMIT = 100
const PRICE_MATCH_TOLERANCE = 0.01

function makeId(prefix) {
  return `${prefix}_${randomUUID()}`
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function normalizeText(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function normalizeAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100) / 100
}

function toBoolInt(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value ? 1 : 0
  return ['1', 'true', 'yes', 'on', 'active', 'available'].includes(String(value).trim().toLowerCase()) ? 1 : 0
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function extractArrayPayload(response, keys = []) {
  if (Array.isArray(response)) return response

  for (const key of keys) {
    if (Array.isArray(response?.[key])) return response[key]
  }

  if (Array.isArray(response?.data)) return response.data

  for (const key of keys) {
    if (Array.isArray(response?.data?.[key])) return response.data[key]
  }

  return []
}

function getRecordId(record = {}, aliases = []) {
  const id = record.id || record._id || aliases.map(alias => record[alias]).find(Boolean)
  return cleanString(id)
}

function normalizeProductType(value) {
  const normalized = cleanString(value || DEFAULT_PRODUCT_TYPE).toUpperCase()
  return ['PHYSICAL', 'DIGITAL'].includes(normalized) ? normalized : DEFAULT_PRODUCT_TYPE
}

function normalizePriceType(value) {
  const normalized = cleanString(value || DEFAULT_PRICE_TYPE).toLowerCase()
  return normalized === 'recurring' ? 'recurring' : DEFAULT_PRICE_TYPE
}

function normalizeCurrency(value) {
  return cleanString(value || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY
}

function normalizeProductRecord(raw = {}, options = {}) {
  const product = raw.product && typeof raw.product === 'object' ? raw.product : raw
  const source = options.source || product.source || (product.ghlProductId || product.ghl_product_id ? 'ghl' : 'ristak')
  const sourceIsGhl = source === 'ghl'
  const ghlProductId = cleanString(
    options.ghlProductId ||
    product.ghlProductId ||
    product.ghl_product_id ||
    product.productId ||
    product.product_id ||
    (sourceIsGhl ? getRecordId(product) : '')
  ) || null
  const localId = cleanString(
    options.id ||
    product.localId ||
    product.local_id ||
    product.ristakProductId ||
    (sourceIsGhl ? '' : getRecordId(product))
  )
  const name = cleanString(product.name || product.title || product.productName || product.displayName || 'Producto')
  const productType = normalizeProductType(product.productType || product.product_type || product.type)

  return {
    id: localId || makeId(LOCAL_PRODUCT_PREFIX),
    ghlProductId,
    locationId: cleanString(options.locationId || product.locationId || product.location_id || '') || null,
    name,
    description: cleanString(product.description || product.shortDescription || product.details || ''),
    productType,
    image: cleanString(product.image || product.imageUrl || product.image_url || '') || null,
    availableInStore: toBoolInt(product.availableInStore ?? product.available_in_store, false),
    currency: normalizeCurrency(product.currency || product.defaultCurrency),
    isActive: toBoolInt(product.isActive ?? product.is_active ?? product.active, true),
    source,
    syncStatus: options.syncStatus || product.syncStatus || product.sync_status || (sourceIsGhl ? 'synced' : 'pending'),
    syncOrigin: options.syncOrigin || product.syncOrigin || product.sync_origin || source,
    syncError: options.syncError || product.syncError || product.sync_error || null,
    rawJson: jsonOrNull(options.rawJson || product.raw_json || (sourceIsGhl ? raw : null))
  }
}

function normalizePriceRecord(raw = {}, options = {}) {
  const price = raw.price && typeof raw.price === 'object' ? raw.price : raw
  const source = options.source || price.source || (price.ghlPriceId || price.ghl_price_id ? 'ghl' : 'ristak')
  const sourceIsGhl = source === 'ghl'
  const recurring = price.recurring && typeof price.recurring === 'object' ? price.recurring : {}
  const amount = normalizeAmount(
    price.amount ??
    price.price ??
    price.unitAmount ??
    price.unit_amount ??
    price.unit_amount_decimal ??
    price.value
  )
  const type = normalizePriceType(price.type || price.pricingType || price.pricing_type)

  return {
    id: cleanString(
      options.id ||
      price.localId ||
      price.local_id ||
      price.ristakPriceId ||
      (sourceIsGhl ? '' : getRecordId(price))
    ) || makeId(LOCAL_PRICE_PREFIX),
    productId: cleanString(options.productId || price.localProductId || price.product_id || price.productId || price.product || ''),
    ghlPriceId: cleanString(
      options.ghlPriceId ||
      price.ghlPriceId ||
      price.ghl_price_id ||
      price.priceId ||
      price.price_id ||
      (sourceIsGhl ? getRecordId(price, ['_id']) : '')
    ) || null,
    ghlProductId: cleanString(options.ghlProductId || price.ghlProductId || price.ghl_product_id || price.product || '') || null,
    locationId: cleanString(options.locationId || price.locationId || price.location_id || '') || null,
    name: cleanString(price.name || price.nickname || price.label || 'Precio'),
    type,
    currency: normalizeCurrency(price.currency || price.currencyCode),
    amount,
    description: cleanString(price.description || ''),
    interval: cleanString(recurring.interval || price.interval || '') || null,
    intervalCount: Number(recurring.intervalCount || price.intervalCount || price.interval_count || 0) || null,
    trialPeriod: Number(price.trialPeriod || price.trial_period || 0) || null,
    totalCycles: Number(price.totalCycles || price.total_cycles || 0) || null,
    setupFee: normalizeAmount(price.setupFee || price.setup_fee || 0) || null,
    compareAtPrice: normalizeAmount(price.compareAtPrice || price.compare_at_price || 0) || null,
    sku: cleanString(price.sku || '') || null,
    trackInventory: toBoolInt(price.trackInventory ?? price.track_inventory, false),
    availableQuantity: price.availableQuantity ?? price.available_quantity ?? null,
    allowOutOfStockPurchases: toBoolInt(price.allowOutOfStockPurchases ?? price.allow_out_of_stock_purchases, false),
    isDigitalProduct: toBoolInt(price.isDigitalProduct ?? price.is_digital_product, true),
    variantOptionIds: jsonOrNull(price.variantOptionIds || price.variant_option_ids || []),
    shippingOptions: jsonOrNull(price.shippingOptions || price.shipping_options || null),
    metadata: jsonOrNull(price.meta || price.metadata || null),
    source,
    syncStatus: options.syncStatus || price.syncStatus || price.sync_status || (sourceIsGhl ? 'synced' : 'pending'),
    syncOrigin: options.syncOrigin || price.syncOrigin || price.sync_origin || source,
    syncError: options.syncError || price.syncError || price.sync_error || null,
    rawJson: jsonOrNull(options.rawJson || price.raw_json || (sourceIsGhl ? raw : null))
  }
}

export function productRowToApi(row = {}, prices = undefined) {
  const publicId = row.ghl_product_id || row.id
  return {
    _id: publicId,
    id: publicId,
    localId: row.id,
    ghlProductId: row.ghl_product_id || null,
    locationId: row.location_id || null,
    name: row.name || 'Producto',
    description: row.description || '',
    productType: row.product_type || DEFAULT_PRODUCT_TYPE,
    image: row.image || null,
    availableInStore: row.available_in_store === 1 || row.available_in_store === true,
    currency: row.currency || DEFAULT_CURRENCY,
    isActive: row.is_active !== 0,
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncOrigin: row.sync_origin || row.source || 'ristak',
    syncError: row.sync_error || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    ...(prices !== undefined ? { prices } : {})
  }
}

export function priceRowToApi(row = {}) {
  const publicId = row.ghl_price_id || row.id
  return {
    _id: publicId,
    id: publicId,
    localId: row.id,
    productId: row.ghl_product_id || row.product_id,
    localProductId: row.product_id,
    ghlPriceId: row.ghl_price_id || null,
    ghlProductId: row.ghl_product_id || null,
    locationId: row.location_id || null,
    name: row.name || 'Precio',
    type: row.type || DEFAULT_PRICE_TYPE,
    currency: row.currency || DEFAULT_CURRENCY,
    amount: normalizeAmount(row.amount),
    price: normalizeAmount(row.amount),
    description: row.description || '',
    interval: row.interval || null,
    intervalCount: row.interval_count || null,
    sku: row.sku || null,
    source: row.source || 'ristak',
    syncStatus: row.sync_status || 'pending',
    syncOrigin: row.sync_origin || row.source || 'ristak',
    syncError: row.sync_error || null,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

export async function getLocalProduct(productId) {
  const cleanId = cleanString(productId)
  if (!cleanId) return null

  return db.get(
    'SELECT * FROM products WHERE id = ? OR ghl_product_id = ? LIMIT 1',
    [cleanId, cleanId]
  )
}

export async function getLocalPrice(priceId) {
  const cleanId = cleanString(priceId)
  if (!cleanId) return null

  return db.get(
    'SELECT * FROM product_prices WHERE id = ? OR ghl_price_id = ? LIMIT 1',
    [cleanId, cleanId]
  )
}

async function findUnlinkedProductByName(name) {
  const cleanName = cleanString(name)
  if (!cleanName) return null

  return db.get(
    `SELECT *
     FROM products
     WHERE (ghl_product_id IS NULL OR ghl_product_id = '')
       AND LOWER(name) = LOWER(?)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [cleanName]
  )
}

async function findUnlinkedPriceBySignature(productId, price) {
  if (!productId || !price?.name) return null

  return db.get(
    `SELECT *
     FROM product_prices
     WHERE product_id = ?
       AND (ghl_price_id IS NULL OR ghl_price_id = '')
       AND LOWER(name) = LOWER(?)
       AND LOWER(COALESCE(currency, ?)) = LOWER(?)
       AND LOWER(COALESCE(type, ?)) = LOWER(?)
       AND ABS(COALESCE(amount, 0) - ?) <= ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [
      productId,
      price.name,
      DEFAULT_CURRENCY,
      price.currency || DEFAULT_CURRENCY,
      DEFAULT_PRICE_TYPE,
      price.type || DEFAULT_PRICE_TYPE,
      normalizeAmount(price.amount),
      PRICE_MATCH_TOLERANCE
    ]
  )
}

export async function upsertLocalProduct(raw = {}, options = {}) {
  const normalized = normalizeProductRecord(raw, options)
  const existingByGhl = normalized.ghlProductId ? await getLocalProduct(normalized.ghlProductId) : null
  const existingByName = normalized.ghlProductId && !existingByGhl
    ? await findUnlinkedProductByName(normalized.name)
    : null
  const existing = existingByGhl || existingByName

  if (existing?.id) {
    normalized.id = existing.id
    normalized.source = existing.source || normalized.source
  }

  await db.run(`
    INSERT INTO products (
      id, ghl_product_id, location_id, name, description, product_type,
      image, available_in_store, currency, is_active, source, sync_status,
      sync_origin, sync_error, raw_json, last_synced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      ghl_product_id = COALESCE(excluded.ghl_product_id, products.ghl_product_id),
      location_id = COALESCE(excluded.location_id, products.location_id),
      name = excluded.name,
      description = excluded.description,
      product_type = excluded.product_type,
      image = COALESCE(excluded.image, products.image),
      available_in_store = excluded.available_in_store,
      currency = excluded.currency,
      is_active = excluded.is_active,
      source = COALESCE(products.source, excluded.source),
      sync_status = excluded.sync_status,
      sync_origin = excluded.sync_origin,
      sync_error = excluded.sync_error,
      raw_json = COALESCE(excluded.raw_json, products.raw_json),
      last_synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE products.last_synced_at END,
      updated_at = CURRENT_TIMESTAMP
  `, [
    normalized.id,
    normalized.ghlProductId,
    normalized.locationId,
    normalized.name,
    normalized.description,
    normalized.productType,
    normalized.image,
    normalized.availableInStore,
    normalized.currency,
    normalized.isActive,
    normalized.source,
    normalized.syncStatus,
    normalized.syncOrigin,
    normalized.syncError,
    normalized.rawJson,
    normalized.syncStatus
  ])

  return getLocalProduct(normalized.id)
}

export async function upsertLocalPrice(raw = {}, options = {}) {
  const normalized = normalizePriceRecord(raw, options)
  const product = await getLocalProduct(normalized.productId || normalized.ghlProductId)

  if (!product?.id) {
    throw new Error('No se encontro el producto local para guardar el precio.')
  }

  normalized.productId = product.id
  normalized.ghlProductId = normalized.ghlProductId || product.ghl_product_id || null
  normalized.locationId = normalized.locationId || product.location_id || null

  const existingByGhl = normalized.ghlPriceId ? await getLocalPrice(normalized.ghlPriceId) : null
  const existingBySignature = normalized.ghlPriceId && !existingByGhl
    ? await findUnlinkedPriceBySignature(product.id, normalized)
    : null
  const existing = existingByGhl || existingBySignature

  if (existing?.id) {
    normalized.id = existing.id
    normalized.source = existing.source || normalized.source
  }

  await db.run(`
    INSERT INTO product_prices (
      id, product_id, ghl_price_id, ghl_product_id, location_id, name, type,
      currency, amount, description, interval, interval_count, trial_period,
      total_cycles, setup_fee, compare_at_price, sku, track_inventory,
      available_quantity, allow_out_of_stock_purchases, is_digital_product,
      variant_option_ids, shipping_options, metadata, source, sync_status,
      sync_origin, sync_error, raw_json, last_synced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      product_id = excluded.product_id,
      ghl_price_id = COALESCE(excluded.ghl_price_id, product_prices.ghl_price_id),
      ghl_product_id = COALESCE(excluded.ghl_product_id, product_prices.ghl_product_id),
      location_id = COALESCE(excluded.location_id, product_prices.location_id),
      name = excluded.name,
      type = excluded.type,
      currency = excluded.currency,
      amount = excluded.amount,
      description = excluded.description,
      interval = excluded.interval,
      interval_count = excluded.interval_count,
      trial_period = excluded.trial_period,
      total_cycles = excluded.total_cycles,
      setup_fee = excluded.setup_fee,
      compare_at_price = excluded.compare_at_price,
      sku = excluded.sku,
      track_inventory = excluded.track_inventory,
      available_quantity = excluded.available_quantity,
      allow_out_of_stock_purchases = excluded.allow_out_of_stock_purchases,
      is_digital_product = excluded.is_digital_product,
      variant_option_ids = excluded.variant_option_ids,
      shipping_options = excluded.shipping_options,
      metadata = excluded.metadata,
      source = COALESCE(product_prices.source, excluded.source),
      sync_status = excluded.sync_status,
      sync_origin = excluded.sync_origin,
      sync_error = excluded.sync_error,
      raw_json = COALESCE(excluded.raw_json, product_prices.raw_json),
      last_synced_at = CASE WHEN excluded.sync_status = 'synced' THEN CURRENT_TIMESTAMP ELSE product_prices.last_synced_at END,
      updated_at = CURRENT_TIMESTAMP
  `, [
    normalized.id,
    normalized.productId,
    normalized.ghlPriceId,
    normalized.ghlProductId,
    normalized.locationId,
    normalized.name,
    normalized.type,
    normalized.currency,
    normalized.amount,
    normalized.description,
    normalized.interval,
    normalized.intervalCount,
    normalized.trialPeriod,
    normalized.totalCycles,
    normalized.setupFee,
    normalized.compareAtPrice,
    normalized.sku,
    normalized.trackInventory,
    normalized.availableQuantity,
    normalized.allowOutOfStockPurchases,
    normalized.isDigitalProduct,
    normalized.variantOptionIds,
    normalized.shippingOptions,
    normalized.metadata,
    normalized.source,
    normalized.syncStatus,
    normalized.syncOrigin,
    normalized.syncError,
    normalized.rawJson,
    normalized.syncStatus
  ])

  return getLocalPrice(normalized.id)
}

export async function listLocalPrices(productId) {
  const product = await getLocalProduct(productId)
  if (!product?.id) return []

  const rows = await db.all(
    `SELECT *
     FROM product_prices
     WHERE product_id = ?
     ORDER BY name ASC, amount ASC`,
    [product.id]
  )

  return rows.map(priceRowToApi)
}

export async function listLocalProducts({ limit = 100, offset = 0, query = '', includePrices = true, includeInactive = false } = {}) {
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const params = []
  const where = []

  if (!includeInactive) {
    where.push('COALESCE(is_active, 1) != 0')
  }

  const cleanQuery = cleanString(query)
  if (cleanQuery) {
    where.push(`LOWER(COALESCE(name, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(ghl_product_id, '') || ' ' || COALESCE(id, '')) LIKE LOWER(?)`)
    params.push(`%${cleanQuery}%`)
  }

  params.push(safeLimit, safeOffset)

  const rows = await db.all(
    `SELECT *
     FROM products
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY name ASC
     LIMIT ? OFFSET ?`,
    params
  )

  const products = []
  for (const row of rows) {
    const prices = includePrices ? await listLocalPrices(row.id) : undefined
    products.push(productRowToApi(row, prices))
  }

  return { products, total: products.length }
}

export async function createLocalProduct(input = {}, options = {}) {
  const product = await upsertLocalProduct(input, {
    source: 'ristak',
    syncStatus: 'pending',
    syncOrigin: 'ristak'
  })

  const priceInputs = Array.isArray(input.prices) && input.prices.length
    ? input.prices
    : (input.price || input.amount || input.productPrice)
      ? [{
          name: input.priceName || input.name || 'Precio',
          amount: input.price || input.amount || input.productPrice,
          currency: input.currency,
          type: input.priceType || DEFAULT_PRICE_TYPE,
          description: input.priceDescription || input.description || ''
        }]
      : []

  for (const priceInput of priceInputs) {
    await upsertLocalPrice(priceInput, {
      productId: product.id,
      source: 'ristak',
      syncStatus: 'pending',
      syncOrigin: 'ristak'
    })
  }

  const config = await getHighLevelConfig()
  const highLevelConnected = Boolean(config?.api_token && config?.location_id)

  if (options.sync !== false) {
    try {
      const syncResult = await syncProductWithSavedConfig(product.id)
      if (highLevelConnected && syncResult?.skipped) {
        throw new Error('HighLevel esta conectado, pero no se pudo iniciar la sincronizacion del producto.')
      }
    } catch (error) {
      if (highLevelConnected) {
        await db.run('DELETE FROM product_prices WHERE product_id = ?', [product.id])
        await db.run('DELETE FROM products WHERE id = ?', [product.id])
        throw new Error(`No se creo el producto porque HighLevel esta conectado y debe quedar espejado: ${error.message}`)
      }

      logger.warn(`No se pudo sincronizar producto local ${product.id}: ${error.message}`)
    }
  }

  const prices = await listLocalPrices(product.id)
  const freshProduct = await getLocalProduct(product.id)
  return productRowToApi(freshProduct, prices)
}

export async function createLocalPrice(productId, input = {}, options = {}) {
  const price = await upsertLocalPrice(input, {
    productId,
    source: 'ristak',
    syncStatus: 'pending',
    syncOrigin: 'ristak'
  })

  const config = await getHighLevelConfig()
  const highLevelConnected = Boolean(config?.api_token && config?.location_id)

  if (options.sync !== false) {
    try {
      const syncResult = await syncProductWithSavedConfig(price.product_id)
      if (highLevelConnected && syncResult?.skipped) {
        throw new Error('HighLevel esta conectado, pero no se pudo iniciar la sincronizacion del precio.')
      }
    } catch (error) {
      if (highLevelConnected) {
        await db.run('DELETE FROM product_prices WHERE id = ?', [price.id])
        throw new Error(`No se creo el precio porque HighLevel esta conectado y debe quedar espejado: ${error.message}`)
      }

      logger.warn(`No se pudo sincronizar precio local ${price.id}: ${error.message}`)
    }
  }

  const freshPrice = await getLocalPrice(price.id)
  return priceRowToApi(freshPrice)
}

export async function updateLocalProduct(productId, input = {}, options = {}) {
  const existing = await getLocalProduct(productId)
  if (!existing?.id) {
    throw new Error('Producto no encontrado.')
  }

  const updated = await upsertLocalProduct({
    ...existing,
    ...input,
    id: existing.id,
    ghlProductId: existing.ghl_product_id,
    locationId: existing.location_id,
    source: existing.source || 'ristak',
    syncOrigin: existing.sync_origin || existing.source || 'ristak',
    isActive: input.isActive ?? input.is_active ?? existing.is_active
  }, {
    id: existing.id,
    ghlProductId: existing.ghl_product_id,
    locationId: existing.location_id,
    source: existing.source || 'ristak',
    syncStatus: 'pending',
    syncOrigin: existing.sync_origin || existing.source || 'ristak'
  })

  const priceInput = Array.isArray(input.prices) && input.prices.length
    ? input.prices[0]
    : (input.price !== undefined || input.amount !== undefined || input.productPrice !== undefined)
      ? {
          name: input.priceName || input.name || 'Precio',
          amount: input.price ?? input.amount ?? input.productPrice,
          currency: input.currency,
          type: input.priceType || DEFAULT_PRICE_TYPE,
          description: input.priceDescription || input.description || ''
        }
      : null

  if (priceInput) {
    const existingPrices = await listLocalPrices(existing.id)
    const existingPrice = existingPrices[0] || null
    await upsertLocalPrice({
      ...existingPrice,
      ...priceInput,
      id: existingPrice?.localId || existingPrice?.id,
      ghlPriceId: existingPrice?.ghlPriceId,
      productId: existing.id,
      localProductId: existing.id,
      ghlProductId: existing.ghl_product_id
    }, {
      id: existingPrice?.localId,
      productId: existing.id,
      ghlProductId: existing.ghl_product_id,
      locationId: existing.location_id,
      source: existingPrice?.source || existing.source || 'ristak',
      syncStatus: 'pending',
      syncOrigin: existingPrice?.syncOrigin || existing.sync_origin || existing.source || 'ristak'
    })
  }

  const config = await getHighLevelConfig()
  const highLevelConnected = Boolean(config?.api_token && config?.location_id)

  if (options.sync !== false) {
    try {
      const syncResult = await syncProductWithSavedConfig(existing.id)
      if (highLevelConnected && syncResult?.skipped) {
        throw new Error('HighLevel esta conectado, pero no se pudo iniciar la sincronizacion del producto.')
      }
    } catch (error) {
      if (highLevelConnected) {
        throw new Error(`No se actualizo el producto en HighLevel: ${error.message}`)
      }

      logger.warn(`No se pudo sincronizar producto actualizado ${existing.id}: ${error.message}`)
    }
  }

  const prices = await listLocalPrices(existing.id)
  const freshProduct = await getLocalProduct(updated.id)
  return productRowToApi(freshProduct, prices)
}

export async function deleteLocalProduct(productId) {
  const existing = await getLocalProduct(productId)
  if (!existing?.id) {
    throw new Error('Producto no encontrado.')
  }

  await db.run(
    `UPDATE products
     SET is_active = 0,
         sync_status = CASE WHEN COALESCE(ghl_product_id, '') = '' THEN sync_status ELSE 'pending' END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [existing.id]
  )

  return { id: existing.ghl_product_id || existing.id, localId: existing.id, deleted: true }
}

function buildGhlProductPayload(row = {}, locationId) {
  const payload = {
    name: row.name,
    locationId,
    description: row.description || '',
    productType: normalizeProductType(row.product_type),
    availableInStore: row.available_in_store === 1 || row.available_in_store === true
  }

  if (row.image) {
    payload.image = row.image
    payload.medias = [{
      id: randomUUID(),
      title: row.name,
      url: row.image,
      type: 'image',
      isFeatured: true
    }]
  }

  return payload
}

function buildGhlPricePayload(row = {}, productRow = {}, locationId) {
  const type = normalizePriceType(row.type)
  const payload = {
    product: productRow.ghl_product_id,
    locationId,
    name: row.name,
    type,
    currency: normalizeCurrency(row.currency),
    amount: normalizeAmount(row.amount),
    description: row.description || '',
    sku: row.sku || undefined,
    trackInventory: row.track_inventory === 1 || row.track_inventory === true,
    isDigitalProduct: normalizeProductType(productRow.product_type) === 'DIGITAL'
  }

  if (type === 'recurring') {
    payload.recurring = {
      interval: row.interval || 'month',
      intervalCount: Number(row.interval_count || 1)
    }
  }

  if (row.available_quantity !== null && row.available_quantity !== undefined) {
    payload.availableQuantity = Number(row.available_quantity)
  }
  if (row.allow_out_of_stock_purchases !== null && row.allow_out_of_stock_purchases !== undefined) {
    payload.allowOutOfStockPurchases = row.allow_out_of_stock_purchases === 1 || row.allow_out_of_stock_purchases === true
  }
  if (row.variant_option_ids) {
    const variantOptionIds = parseJson(row.variant_option_ids, [])
    if (Array.isArray(variantOptionIds) && variantOptionIds.length) payload.variantOptionIds = variantOptionIds
  }
  if (row.shipping_options) {
    const shippingOptions = parseJson(row.shipping_options, null)
    if (shippingOptions && typeof shippingOptions === 'object') payload.shippingOptions = shippingOptions
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
}

function normalizeGhlProduct(rawProduct = {}) {
  const product = rawProduct.product && typeof rawProduct.product === 'object' ? rawProduct.product : rawProduct
  return normalizeProductRecord(product, {
    source: 'ghl',
    syncStatus: 'synced',
    syncOrigin: 'ghl',
    ghlProductId: getRecordId(product, ['productId', 'product_id']),
    rawJson: rawProduct
  })
}

function normalizeGhlPrice(rawPrice = {}, productRow = {}) {
  const price = rawPrice.price && typeof rawPrice.price === 'object' ? rawPrice.price : rawPrice
  return normalizePriceRecord(price, {
    source: 'ghl',
    syncStatus: 'synced',
    syncOrigin: 'ghl',
    productId: productRow.id,
    ghlProductId: productRow.ghl_product_id,
    ghlPriceId: getRecordId(price, ['priceId', 'price_id']),
    rawJson: rawPrice
  })
}

function remoteProductMatches(row, remoteProduct) {
  return normalizeText(row.name) && normalizeText(row.name) === normalizeText(remoteProduct.name || remoteProduct.title || remoteProduct.productName)
}

function remotePriceMatches(row, remotePrice) {
  const normalized = normalizePriceRecord(remotePrice, { source: 'ghl' })
  return normalizeText(row.name) === normalizeText(normalized.name) &&
    normalizeCurrency(row.currency) === normalizeCurrency(normalized.currency) &&
    normalizePriceType(row.type) === normalizePriceType(normalized.type) &&
    Math.abs(normalizeAmount(row.amount) - normalizeAmount(normalized.amount)) <= PRICE_MATCH_TOLERANCE
}

async function findRemoteProductMatch(client, row) {
  for (let page = 0; page < 5; page += 1) {
    const response = await client.listProducts({
      limit: PRODUCT_PAGE_LIMIT,
      offset: page * PRODUCT_PAGE_LIMIT
    })
    const products = extractArrayPayload(response, ['products', 'data', 'items', 'results'])
    const match = products.find(product => remoteProductMatches(row, product))
    if (match) return match
    if (products.length < PRODUCT_PAGE_LIMIT) break
  }

  return null
}

async function findRemotePriceMatch(client, productRow, priceRow) {
  if (!productRow?.ghl_product_id) return null

  const response = await client.listPrices(productRow.ghl_product_id)
  const prices = extractArrayPayload(response, ['prices', 'data', 'items', 'results'])
  return prices.find(price => remotePriceMatches(priceRow, price)) || null
}

export async function syncProductRowToHighLevel(productRow, client, locationId) {
  if (!productRow?.id) throw new Error('Producto local invalido para sincronizar.')

  let row = productRow
  const payload = buildGhlProductPayload(row, locationId)
  let response
  let action = 'updated'

  try {
    if (row.ghl_product_id) {
      response = await client.updateProduct(row.ghl_product_id, payload)
    } else {
      const remoteMatch = await findRemoteProductMatch(client, row)
      if (remoteMatch) {
        const matched = await upsertLocalProduct(remoteMatch, {
          source: 'ghl',
          locationId,
          syncStatus: 'synced',
          syncOrigin: row.source || 'ristak'
        })
        return { product: matched, action: 'matched' }
      }

      response = await client.createProduct(payload)
      action = 'created'
    }

    const created = response.product || response.data || response
    const ghlProductId = getRecordId(created, ['productId', 'product_id'])
    if (!ghlProductId) {
      throw new Error('HighLevel no devolvio el ID del producto.')
    }

    await db.run(
      `UPDATE products
       SET ghl_product_id = ?,
           location_id = ?,
           sync_status = 'synced',
           sync_error = NULL,
           raw_json = COALESCE(?, raw_json),
           last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [ghlProductId, locationId, jsonOrNull(response), row.id]
    )

    return { product: await getLocalProduct(row.id), action }
  } catch (error) {
    await db.run(
      `UPDATE products
       SET sync_status = 'error',
           sync_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cleanString(error.message).slice(0, 1000), row.id]
    )
    throw error
  }
}

export async function syncPriceRowToHighLevel(priceRow, client, locationId) {
  if (!priceRow?.id) throw new Error('Precio local invalido para sincronizar.')

  let productRow = await getLocalProduct(priceRow.product_id)
  if (!productRow?.ghl_product_id) {
    const synced = await syncProductRowToHighLevel(productRow, client, locationId)
    productRow = synced.product
  }

  const payload = buildGhlPricePayload(priceRow, productRow, locationId)
  let response
  let action = 'updated'

  try {
    if (priceRow.ghl_price_id) {
      response = await client.updatePrice(productRow.ghl_product_id, priceRow.ghl_price_id, payload)
    } else {
      const remoteMatch = await findRemotePriceMatch(client, productRow, priceRow)
      if (remoteMatch) {
        const matched = await upsertLocalPrice(remoteMatch, {
          productId: productRow.id,
          ghlProductId: productRow.ghl_product_id,
          source: 'ghl',
          locationId,
          syncStatus: 'synced',
          syncOrigin: priceRow.source || 'ristak'
        })
        return { price: matched, action: 'matched' }
      }

      response = await client.createPrice(productRow.ghl_product_id, payload)
      action = 'created'
    }

    const created = response.price || response.data || response
    const ghlPriceId = getRecordId(created, ['priceId', 'price_id'])
    if (!ghlPriceId) {
      throw new Error('HighLevel no devolvio el ID del precio.')
    }

    await db.run(
      `UPDATE product_prices
       SET ghl_price_id = ?,
           ghl_product_id = ?,
           location_id = ?,
           sync_status = 'synced',
           sync_error = NULL,
           raw_json = COALESCE(?, raw_json),
           last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [ghlPriceId, productRow.ghl_product_id, locationId, jsonOrNull(response), priceRow.id]
    )

    return { price: await getLocalPrice(priceRow.id), action }
  } catch (error) {
    await db.run(
      `UPDATE product_prices
       SET sync_status = 'error',
           sync_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cleanString(error.message).slice(0, 1000), priceRow.id]
    )
    throw error
  }
}

export async function syncHighLevelProductsToLocal(locationId, apiToken) {
  const client = new GHLClient(apiToken, locationId)
  let savedProducts = 0
  let savedPrices = 0
  let totalProducts = 0
  const remoteProductIds = new Set()

  for (let page = 0; page < 50; page += 1) {
    const response = await client.listProducts({
      limit: PRODUCT_PAGE_LIMIT,
      offset: page * PRODUCT_PAGE_LIMIT
    })
    const remoteProducts = extractArrayPayload(response, ['products', 'data', 'items', 'results'])
    totalProducts += remoteProducts.length

    for (const remoteProduct of remoteProducts) {
      const normalizedRemoteProduct = normalizeGhlProduct(remoteProduct)
      if (normalizedRemoteProduct.ghlProductId) {
        remoteProductIds.add(normalizedRemoteProduct.ghlProductId)
      }
      const product = await upsertLocalProduct(normalizeGhlProduct(remoteProduct), {
        source: 'ghl',
        locationId,
        syncStatus: 'synced',
        syncOrigin: 'ghl',
        rawJson: remoteProduct
      })
      savedProducts += 1

      try {
        const pricesResponse = await client.listPrices(product.ghl_product_id)
        const remotePrices = extractArrayPayload(pricesResponse, ['prices', 'data', 'items', 'results'])
        for (const remotePrice of remotePrices) {
          await upsertLocalPrice(normalizeGhlPrice(remotePrice, product), {
            productId: product.id,
            ghlProductId: product.ghl_product_id,
            source: 'ghl',
            locationId,
            syncStatus: 'synced',
            syncOrigin: 'ghl',
            rawJson: remotePrice
          })
          savedPrices += 1
        }
      } catch (error) {
        logger.warn(`No se pudieron sincronizar precios del producto ${product.ghl_product_id}: ${error.message}`)
      }
    }

    if (remoteProducts.length < PRODUCT_PAGE_LIMIT) break
  }

  const prunedProducts = await pruneStaleHighLevelProducts(locationId, [...remoteProductIds])

  return { total: totalProducts, savedProducts, savedPrices, prunedProducts }
}

async function pruneStaleHighLevelProducts(locationId, remoteProductIds = []) {
  const cleanLocationId = cleanString(locationId)
  if (!cleanLocationId) return 0

  const staleLocationRows = await db.all(
    `SELECT id
     FROM products
     WHERE COALESCE(source, '') = 'ghl'
       AND COALESCE(location_id, '') != ?`,
    [cleanLocationId]
  )

  const staleCurrentRows = remoteProductIds.length
    ? await db.all(
        `SELECT id
         FROM products
         WHERE COALESCE(source, '') = 'ghl'
           AND COALESCE(location_id, '') = ?
           AND COALESCE(ghl_product_id, '') != ''
           AND ghl_product_id NOT IN (${remoteProductIds.map(() => '?').join(', ')})`,
        [cleanLocationId, ...remoteProductIds]
      )
    : await db.all(
        `SELECT id
         FROM products
         WHERE COALESCE(source, '') = 'ghl'
           AND COALESCE(location_id, '') = ?
           AND COALESCE(ghl_product_id, '') != ''`,
        [cleanLocationId]
      )

  const staleIds = [...new Set([...staleLocationRows, ...staleCurrentRows].map(row => row.id).filter(Boolean))]
  for (const productId of staleIds) {
    await db.run('DELETE FROM product_prices WHERE product_id = ?', [productId])
    await db.run('DELETE FROM products WHERE id = ?', [productId])
  }

  if (staleIds.length) {
    logger.info(`Productos espejo de HighLevel podados localmente: ${staleIds.length}`)
  }

  return staleIds.length
}

export async function syncLocalProductsToHighLevel(locationId, apiToken) {
  const client = new GHLClient(apiToken, locationId)
  const result = {
    total: 0,
    created: 0,
    updated: 0,
    matched: 0,
    failed: 0,
    pricesCreated: 0,
    pricesUpdated: 0,
    pricesMatched: 0,
    pricesFailed: 0
  }

  const products = await db.all(
    `SELECT *
     FROM products
     WHERE COALESCE(is_active, 1) != 0
       AND (COALESCE(ghl_product_id, '') = '' OR COALESCE(sync_status, 'pending') != 'synced')
     ORDER BY created_at ASC`
  )

  result.total += products.length

  for (const product of products) {
    try {
      const synced = await syncProductRowToHighLevel(product, client, locationId)
      if (synced.action === 'created') result.created += 1
      else if (synced.action === 'matched') result.matched += 1
      else result.updated += 1
    } catch (error) {
      result.failed += 1
      logger.warn(`Producto ${product.id} no sincronizado a HighLevel: ${error.message}`)
    }
  }

  const prices = await db.all(
    `SELECT pp.*
     FROM product_prices pp
     JOIN products p ON p.id = pp.product_id
     WHERE COALESCE(p.is_active, 1) != 0
       AND COALESCE(p.ghl_product_id, '') != ''
       AND (COALESCE(pp.ghl_price_id, '') = '' OR COALESCE(pp.sync_status, 'pending') != 'synced')
     ORDER BY pp.created_at ASC`
  )

  result.total += prices.length

  for (const price of prices) {
    try {
      const synced = await syncPriceRowToHighLevel(price, client, locationId)
      if (synced.action === 'created') result.pricesCreated += 1
      else if (synced.action === 'matched') result.pricesMatched += 1
      else result.pricesUpdated += 1
    } catch (error) {
      result.pricesFailed += 1
      logger.warn(`Precio ${price.id} no sincronizado a HighLevel: ${error.message}`)
    }
  }

  return result
}

export async function syncProductsWithHighLevel(locationId, apiToken, options = {}) {
  const pull = options.pull !== false
  const push = options.push !== false
  const pulled = pull ? await syncHighLevelProductsToLocal(locationId, apiToken) : { total: 0, savedProducts: 0, savedPrices: 0 }
  const pushed = push ? await syncLocalProductsToHighLevel(locationId, apiToken) : {
    total: 0,
    created: 0,
    updated: 0,
    matched: 0,
    failed: 0,
    pricesCreated: 0,
    pricesUpdated: 0,
    pricesMatched: 0,
    pricesFailed: 0
  }

  return { pulled, pushed }
}

export async function syncProductsWithSavedConfig(options = {}) {
  const config = await getHighLevelConfig()
  if (!config?.api_token || !config?.location_id) {
    return {
      skipped: true,
      reason: 'HighLevel no configurado'
    }
  }

  return syncProductsWithHighLevel(config.location_id, config.api_token, options)
}

export async function syncProductWithSavedConfig(productId) {
  const config = await getHighLevelConfig()
  if (!config?.api_token || !config?.location_id) return { skipped: true }

  const client = new GHLClient(config.api_token, config.location_id)
  const product = await getLocalProduct(productId)
  if (!product) return { skipped: true }

  await syncProductRowToHighLevel(product, client, config.location_id)
  const prices = await db.all('SELECT * FROM product_prices WHERE product_id = ?', [product.id])
  for (const price of prices) {
    await syncPriceRowToHighLevel(price, client, config.location_id)
  }

  return { synced: true }
}

export async function prepareInvoiceCatalogItemsForHighLevel(payload = {}, options = {}) {
  const config = options.config || await getHighLevelConfig()
  if (!config?.api_token || !config?.location_id || !payload || typeof payload !== 'object') {
    return payload
  }

  const client = options.ghlClient || new GHLClient(config.api_token, config.location_id)
  const nextPayload = { ...payload }
  const itemKeys = ['items', 'invoiceItems', 'lineItems']

  for (const key of itemKeys) {
    if (!Array.isArray(nextPayload[key])) continue
    nextPayload[key] = []

    for (const item of payload[key]) {
      nextPayload[key].push(await resolveInvoiceItemCatalogIds(item, client, config.location_id))
    }
  }

  return nextPayload
}

async function resolveInvoiceItemCatalogIds(item = {}, client, locationId) {
  const nextItem = { ...item }
  let productRow = nextItem.productId ? await getLocalProduct(nextItem.productId) : null
  let priceRow = nextItem.priceId ? await getLocalPrice(nextItem.priceId) : null

  if (!productRow && priceRow?.product_id) {
    productRow = await getLocalProduct(priceRow.product_id)
  }

  if (productRow && !productRow.ghl_product_id) {
    const syncedProduct = await syncProductRowToHighLevel(productRow, client, locationId)
    productRow = syncedProduct.product
  }

  if (priceRow && !priceRow.ghl_price_id) {
    const syncedPrice = await syncPriceRowToHighLevel(priceRow, client, locationId)
    priceRow = syncedPrice.price
  }

  if (productRow?.ghl_product_id) {
    nextItem.productId = productRow.ghl_product_id
  }

  if (priceRow?.ghl_price_id) {
    nextItem.priceId = priceRow.ghl_price_id
  }

  return nextItem
}
