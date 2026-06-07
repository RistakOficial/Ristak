/**
 * Cliente HTTP para la API v2 de GoHighLevel (LeadConnector)
 * Base URL: https://services.leadconnectorhq.com
 * Headers obligatorios:
 * - Authorization: Bearer <API_TOKEN>
 * - Version: 2021-07-28
 * - Content-Type: application/json
 */

import fetch from 'node-fetch'
import { getHighLevelConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { formatInvoiceMultilineText, formatInvoicePayloadText } from '../utils/invoiceTextFormatter.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
const GHL_API_VERSION = '2021-07-28'
const GHL_PRODUCTS_API_VERSION = '2023-02-21'
const GHL_CONVERSATIONS_API_VERSION = '2023-02-21'
const GHL_INVOICE_SCHEDULE_API_VERSION = '2023-02-21'
const GHL_INVOICE_SCHEDULE_AUTOPAY_API_VERSION = '2021-07-28'
const MAX_RETRIES = 3
const RETRY_DELAY = 1000 // 1 segundo
const MAX_429_RETRIES = 5
const DEFAULT_429_WAIT_MS = 60000 // 60s si no hay Retry-After header

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeCountryCode(value) {
  const normalized = cleanString(value).toUpperCase()
  if (!normalized) return ''

  const aliases = {
    MEXICO: 'MX',
    MEX: 'MX',
    MXN: 'MX',
    'ESTADOS UNIDOS': 'US',
    'UNITED STATES': 'US',
    USA: 'US',
    EEUU: 'US',
    US: 'US'
  }

  return aliases[normalized] || normalized.slice(0, 2)
}

function normalizeInvoiceAddress(address = {}, fallback = {}) {
  const rawAddress = typeof address === 'string'
    ? { addressLine1: address }
    : address && typeof address === 'object'
      ? address
      : {}

  const addressLine1 = cleanString(
    rawAddress.addressLine1 ||
    rawAddress.line1 ||
    rawAddress.street ||
    rawAddress.address ||
    fallback.addressLine1 ||
    fallback.line1 ||
    fallback.address
  )
  const addressLine2 = cleanString(rawAddress.addressLine2 || rawAddress.line2 || fallback.addressLine2 || fallback.line2)
  const city = cleanString(rawAddress.city || fallback.city)
  const state = cleanString(rawAddress.state || rawAddress.region || fallback.state || fallback.region)
  const countryCode = normalizeCountryCode(rawAddress.countryCode || rawAddress.country || fallback.countryCode || fallback.country)
  const postalCode = cleanString(rawAddress.postalCode || rawAddress.zip || rawAddress.zipCode || fallback.postalCode || fallback.zip || fallback.zipCode)

  const normalized = {}
  if (addressLine1) normalized.addressLine1 = addressLine1
  if (addressLine2) normalized.addressLine2 = addressLine2
  if (city) normalized.city = city
  if (state) normalized.state = state
  if (countryCode) normalized.countryCode = countryCode
  if (postalCode) normalized.postalCode = postalCode

  return Object.keys(normalized).length ? normalized : null
}

function normalizeInvoiceBusinessDetails(businessDetails = {}) {
  const normalized = { ...businessDetails }
  const phoneNo = normalizePhoneForStorage(normalized.phoneNo || normalized.phone) || cleanString(normalized.phoneNo || normalized.phone)
  const address = normalizeInvoiceAddress(normalized.address, normalized)

  delete normalized.phone

  if (phoneNo) normalized.phoneNo = phoneNo
  if (address) {
    normalized.address = address
  } else {
    delete normalized.address
  }

  for (const key of ['addressLine1', 'addressLine2', 'line1', 'line2', 'street', 'city', 'state', 'region', 'country', 'countryCode', 'postalCode', 'zip', 'zipCode']) {
    delete normalized[key]
  }

  return normalized
}

function normalizeInvoicePayload(data = {}) {
  const formatted = formatInvoicePayloadText(data)

  return {
    ...formatted,
    ...(formatted.businessDetails && {
      businessDetails: normalizeInvoiceBusinessDetails(formatted.businessDetails)
    })
  }
}

class GHLClient {
  constructor(apiToken, locationId) {
    this.apiToken = apiToken
    this.locationId = locationId
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  buildUrl(endpoint, params = {}) {
    const url = new URL(`${GHL_BASE_URL}${endpoint}`)

    if (params && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value))
        }
      })
    }

    return url.toString()
  }

  async request(endpoint, options = {}) {
    const { method = 'GET', body, params, version = GHL_API_VERSION } = options
    const url = this.buildUrl(endpoint, params)

    let lastError = null
    let retries429 = 0

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Version': version,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        })

        // Manejar rate limiting (429) con espera y reintentos dedicados
        if (response.status === 429) {
          if (retries429 >= MAX_429_RETRIES) {
            const errorText = await response.text().catch(() => '')
            throw new Error(`GHL API Error (429): Too Many Requests. Se agotaron los reintentos.`)
          }

          const retryAfterHeader = response.headers.get('Retry-After')
          const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : DEFAULT_429_WAIT_MS
          const waitSec = Math.round(waitMs / 1000)

          retries429++
          logger.warn(`GHL rate limit (429) en ${endpoint}. Esperando ${waitSec}s (intento ${retries429}/${MAX_429_RETRIES})...`)
          await this.sleep(waitMs)
          attempt-- // No consumir un intento normal por un rate limit
          continue
        }

        if (!response.ok) {
          const errorText = await response.text()
          let errorData
          try {
            errorData = JSON.parse(errorText)
          } catch {
            errorData = { message: errorText }
          }
          throw new Error(`GHL API Error (${response.status}): ${JSON.stringify(errorData)}`)
        }

        // Algunos endpoints pueden no devolver body
        const contentType = response.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          return await response.json()
        }

        return {}
      } catch (error) {
        lastError = error

        // Si es el último intento, lanzar el error
        if (attempt === MAX_RETRIES - 1) {
          throw lastError
        }

        // Esperar antes de reintentar (backoff exponencial)
        await this.sleep(RETRY_DELAY * Math.pow(2, attempt))
      }
    }

    throw lastError
  }

  async sendConversationMessage(data = {}) {
    const body = { ...data }
    if (Array.isArray(body.attachments) && body.attachments.length === 0) {
      delete body.attachments
    }

    logger.info(`Enviando mensaje por HighLevel Conversations: ${body.type || 'sin tipo'}`)

    return this.request('/conversations/messages', {
      method: 'POST',
      version: GHL_CONVERSATIONS_API_VERSION,
      body
    })
  }

  async exportConversationMessages(options = {}) {
    const {
      contactId,
      conversationId,
      channel,
      startDate,
      endDate,
      limit = 100,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = options

    return this.request('/conversations/messages/export', {
      method: 'GET',
      version: GHL_CONVERSATIONS_API_VERSION,
      params: {
        locationId: this.locationId,
        limit,
        sortBy,
        sortOrder,
        ...(contactId && { contactId }),
        ...(conversationId && { conversationId }),
        ...(channel && { channel }),
        ...(startDate && { startDate }),
        ...(endDate && { endDate })
      }
    })
  }

  async getConversationMessage(messageId) {
    const cleanMessageId = cleanString(messageId)
    if (!cleanMessageId) {
      throw new Error('Se requiere el ID del mensaje de HighLevel')
    }

    return this.request(`/conversations/messages/${encodeURIComponent(cleanMessageId)}`, {
      method: 'GET',
      version: GHL_CONVERSATIONS_API_VERSION
    })
  }

  // ============================================
  // CONTACTS
  // ============================================

  async searchContacts({ email, phone, query, limit = 20 }) {
    const body = {
      locationId: this.locationId,
    }

    if (email) body.email = email
    if (phone) body.phone = normalizePhoneForStorage(phone) || phone
    if (query) body.query = query
    if (limit) body.pageLimit = limit // GHL usa pageLimit, no limit

    logger.info(`Buscando contactos con: ${JSON.stringify({ email, phone, query, limit })}`)

    const response = await this.request('/contacts/search', {
      method: 'POST',
      body
    })

    // Transformar contactos para incluir el campo 'name' completo
    const contacts = (response.contacts || []).map((contact) => {
      const firstName = contact.firstName || ''
      const lastName = contact.lastName || ''
      const fullName = `${firstName} ${lastName}`.trim()

      return {
        ...contact,
        name: fullName || contact.email || contact.phone || 'Sin nombre',
      }
    })

    logger.info(`Contactos encontrados: ${contacts.length}`)

    return { contacts }
  }

  async getContact(contactId) {
    return this.request(`/contacts/${contactId}`, {
      params: {
        locationId: this.locationId
      }
    })
  }

  async listCustomFields({ model = 'contact' } = {}) {
    logger.info(`Obteniendo custom fields de HighLevel para locationId: ${this.locationId}`)

    return this.request(`/locations/${this.locationId}/customFields`, {
      params: {
        ...(model ? { model } : {})
      }
    })
  }

  async createContact({ name, email, phone }) {
    // Separar nombre completo en firstName y lastName
    const nameParts = name.trim().split(' ')
    const firstName = nameParts[0] || ''
    const lastName = nameParts.slice(1).join(' ') || ''

    const body = {
      locationId: this.locationId,
      firstName: firstName,
      lastName: lastName,
      email: email,
      phone: normalizePhoneForStorage(phone) || phone,
    }

    logger.info(`Creando contacto: ${name}`)

    const response = await this.request('/contacts/', {
      method: 'POST',
      body
    })

    // Agregar el campo 'name' completo para el frontend
    const contactData = response.contact || response
    const fullName = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim()

    return {
      contact: {
        ...contactData,
        name: fullName || contactData.email || contactData.phone || 'Sin nombre',
      }
    }
  }

  async upsertContact({ name, firstName, lastName, email, phone, source }) {
    const fullName = cleanString(name || `${firstName || ''} ${lastName || ''}`.trim())
    let resolvedFirstName = cleanString(firstName)
    let resolvedLastName = cleanString(lastName)

    if (!resolvedFirstName && fullName) {
      const nameParts = fullName.split(/\s+/)
      resolvedFirstName = nameParts[0] || ''
      resolvedLastName = resolvedLastName || nameParts.slice(1).join(' ')
    }

    const body = {
      locationId: this.locationId,
      ...(resolvedFirstName && { firstName: resolvedFirstName }),
      ...(resolvedLastName && { lastName: resolvedLastName }),
      ...(fullName && { name: fullName }),
      ...(email && { email }),
      ...(phone && { phone: normalizePhoneForStorage(phone) || phone }),
      ...(source && { source })
    }

    if (!body.email && !body.phone) {
      throw new Error('Email o teléfono requerido para upsert de contacto en HighLevel')
    }

    logger.info(`Upsert de contacto en HighLevel: ${fullName || email || phone}`)

    const response = await this.request('/contacts/upsert', {
      method: 'POST',
      body
    })

    const contactData = response.contact || response
    const responseName = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim()

    return {
      contact: {
        ...contactData,
        name: responseName || contactData.name || contactData.email || contactData.phone || fullName || 'Sin nombre'
      }
    }
  }

  async updateContact(contactId, data) {
    // Separar nombre completo en firstName y lastName si se proporciona
    const body = { ...data }
    if (body.phone) body.phone = normalizePhoneForStorage(body.phone) || body.phone

    if (data.name) {
      const nameParts = data.name.trim().split(' ')
      body.firstName = nameParts[0] || ''
      body.lastName = nameParts.slice(1).join(' ') || ''
      body.name = data.name // GHL también acepta el campo 'name'
      delete body.name // Opcional: eliminar si solo quieres usar firstName/lastName
    }

    logger.info(`Actualizando contacto: ${contactId}`)

    const response = await this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      body
    })

    // Agregar el campo 'name' completo para el frontend
    const contactData = response.contact || response
    const fullName = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim()

    return {
      contact: {
        ...contactData,
        name: fullName || contactData.email || contactData.phone || 'Sin nombre',
      }
    }
  }

  async deleteContact(contactId) {
    logger.info(`Eliminando contacto: ${contactId}`)

    return this.request(`/contacts/${contactId}`, {
      method: 'DELETE'
    })
  }

  async updateContactTags(contactId, tags) {
    logger.info(`Actualizando tags del contacto: ${contactId}`)

    return this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      body: { tags }
    })
  }

  async updateContactCustomFields(contactId, customFields) {
    logger.info(`Actualizando custom fields del contacto: ${contactId}`)

    return this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      body: { customFields }
    })
  }

  async updateContactDND(contactId, dnd, dndSettings = {}) {
    logger.info(`Actualizando DND del contacto: ${contactId}`)

    return this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      body: {
        dnd,
        ...(Object.keys(dndSettings).length > 0 && { dndSettings })
      }
    })
  }

  // ============================================
  // PRODUCTS & PRICES
  // ============================================

  async listProducts({ limit = 50, offset = 0 } = {}) {
    logger.info(`Obteniendo productos (limit: ${limit})`)

    const response = await this.request('/products/', {
      version: GHL_PRODUCTS_API_VERSION,
      params: {
        locationId: this.locationId,
        limit,
        offset
      }
    })

    return response
  }

  async getProduct(productId) {
    return this.request(`/products/${productId}`, {
      version: GHL_PRODUCTS_API_VERSION,
      params: {
        locationId: this.locationId,
      }
    })
  }

  async createProduct(productData = {}) {
    const body = {
      ...productData,
      locationId: productData.locationId || this.locationId
    }

    logger.info(`Creando producto en HighLevel: ${body.name || 'Sin nombre'}`)

    return this.request('/products/', {
      method: 'POST',
      version: GHL_PRODUCTS_API_VERSION,
      body
    })
  }

  async updateProduct(productId, productData = {}) {
    const body = {
      ...productData,
      locationId: productData.locationId || this.locationId
    }

    logger.info(`Actualizando producto en HighLevel: ${productId}`)

    return this.request(`/products/${productId}`, {
      method: 'PUT',
      version: GHL_PRODUCTS_API_VERSION,
      body
    })
  }

  async listPrices(productId) {
    logger.info(`Obteniendo precios para producto: ${productId}`)

    const response = await this.request(`/products/${productId}/price`, {
      version: GHL_PRODUCTS_API_VERSION,
      params: {
        locationId: this.locationId,
      }
    })

    return response
  }

  async createPrice(productId, priceData = {}) {
    const body = {
      ...priceData,
      product: priceData.product || productId,
      locationId: priceData.locationId || this.locationId
    }

    logger.info(`Creando precio en HighLevel para producto: ${productId}`)

    return this.request(`/products/${productId}/price`, {
      method: 'POST',
      version: GHL_PRODUCTS_API_VERSION,
      body
    })
  }

  async updatePrice(productId, priceId, priceData = {}) {
    const body = {
      ...priceData,
      product: priceData.product || productId,
      locationId: priceData.locationId || this.locationId
    }

    logger.info(`Actualizando precio en HighLevel: ${priceId}`)

    return this.request(`/products/${productId}/price/${priceId}`, {
      method: 'PUT',
      version: GHL_PRODUCTS_API_VERSION,
      body
    })
  }

  // ============================================
  // INVOICES
  // ============================================

  async createInvoice(data) {
    // Agregar altId en el body para POST requests
    const bodyWithLocation = {
      ...normalizeInvoicePayload(data),
      altId: this.locationId,
      altType: 'location',
    }

    logger.info(`Creando invoice para contacto: ${data.contactDetails?.name || 'N/A'}`)

    const response = await this.request('/invoices/', {
      method: 'POST',
      body: bodyWithLocation,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })

    logger.success(`Invoice creado: ${response.invoice?.id || response.invoice?._id}`)

    return response
  }

  async recordPayment(invoiceId, { amount, currency, fulfilledAt, note, mode = 'cash', liveMode = true }) {
    const body = {
      altId: this.locationId,
      altType: 'location',
      amount: amount,
      ...(currency ? { currency } : {}),
      notes: formatInvoiceMultilineText(note || ''),
      fulfilledAt: fulfilledAt || new Date().toISOString(),
      mode,
      liveMode,
    }

    logger.info(`Registrando pago para invoice: ${invoiceId} - Monto: ${amount}`)

    const response = await this.request(`/invoices/${invoiceId}/record-payment`, {
      method: 'POST',
      body
    })

    logger.success(`Pago registrado para invoice: ${invoiceId}`)

    return response
  }

  async listPaymentTransactions(params = {}) {
    return this.request('/payments/transactions', {
      params: {
        altId: this.locationId,
        altType: 'location',
        limit: 20,
        offset: 0,
        ...params
      },
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async sendInvoice(invoiceId, options = {}) {
    // Si sendMethod es 'none', no enviar nada (solo crear invoice)
    if (options.sendMethod === 'none') {
      logger.info(`Invoice ${invoiceId} creado pero NO enviado (sendMethod = none)`)
      return { success: true, message: 'Invoice creado pero no enviado' }
    }

    const actionBySendMethod = {
      email: 'email',
      sms: 'sms',
      both: 'sms_and_email',
      sms_and_email: 'sms_and_email',
      send_manually: 'send_manually'
    }

    const body = {
      altId: this.locationId,
      altType: 'location',
      action: actionBySendMethod[options.sendMethod] || 'email',
      liveMode: options.liveMode !== undefined ? options.liveMode : true,
    }

    // Usar userId o sentFrom (requerido por GHL API)
    if (options.userId) {
      body.userId = options.userId
    } else if (options.sentFrom) {
      body.sentFrom = options.sentFrom
    }

    logger.info(`Enviando invoice ${invoiceId} por ${body.action}`)

    return this.request(`/invoices/${invoiceId}/send`, {
      method: 'POST',
      body
    })
  }

  async createInvoiceSchedule(data) {
    const body = {
      ...normalizeInvoicePayload(data),
      altId: this.locationId,
      altType: 'location',
    }

    logger.info(`Creando invoice schedule: ${body.name || 'sin nombre'}`)

    const response = await this.request('/invoices/schedule', {
      method: 'POST',
      body,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })

    const scheduleId = response?._id || response?.id
    logger.success(`Invoice schedule creado: ${scheduleId || 'sin id'}`)
    return response
  }

  async manageInvoiceScheduleAutoPayment(scheduleId, data) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para configurar autopago')
    }

    const body = {
      ...data,
      altId: this.locationId,
      altType: 'location',
      id: data.id || scheduleId
    }

    logger.info(`Configurando autopago para schedule: ${scheduleId} (Version ${GHL_INVOICE_SCHEDULE_AUTOPAY_API_VERSION})`)

    return this.request(`/invoices/schedule/${scheduleId}/auto-payment`, {
      method: 'POST',
      body,
      version: GHL_INVOICE_SCHEDULE_AUTOPAY_API_VERSION
    })
  }

  async scheduleInvoiceSchedule(scheduleId, data = {}) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para activar schedule')
    }

    const body = {
      ...data,
      altId: this.locationId,
      altType: 'location'
    }

    logger.info(`Activando invoice schedule: ${scheduleId} (Version ${GHL_INVOICE_SCHEDULE_API_VERSION})`)

    return this.request(`/invoices/schedule/${scheduleId}/schedule`, {
      method: 'POST',
      body,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async cancelInvoiceSchedule(scheduleId, data = {}) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para cancelar schedule')
    }

    const body = {
      ...data,
      altId: this.locationId,
      altType: 'location'
    }

    logger.info(`Cancelando invoice schedule: ${scheduleId}`)

    return this.request(`/invoices/schedule/${scheduleId}/cancel`, {
      method: 'POST',
      body,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async deleteInvoiceSchedule(scheduleId) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para eliminar schedule')
    }

    logger.info(`Eliminando invoice schedule: ${scheduleId}`)

    return this.request(`/invoices/schedule/${scheduleId}`, {
      method: 'DELETE',
      params: {
        altId: this.locationId,
        altType: 'location'
      },
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async listInvoiceSchedules({ limit = 100, offset = 0 } = {}) {
    return this.request('/invoices/schedule', {
      params: {
        altId: this.locationId,
        altType: 'location',
        limit,
        offset: offset || 0
      },
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async getInvoiceSchedule(scheduleId) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para obtener schedule')
    }

    return this.request(`/invoices/schedule/${scheduleId}`, {
      params: {
        altId: this.locationId,
        altType: 'location'
      },
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async updateInvoiceSchedule(scheduleId, data) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para actualizar schedule')
    }

    const body = {
      ...normalizeInvoicePayload(data),
      altId: this.locationId,
      altType: 'location'
    }

    logger.info(`Actualizando invoice schedule: ${scheduleId}`)

    return this.request(`/invoices/schedule/${scheduleId}`, {
      method: 'PUT',
      body,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async updateAndScheduleInvoiceSchedule(scheduleId, data) {
    if (!scheduleId) {
      throw new Error('scheduleId requerido para actualizar schedule activo')
    }

    const body = {
      ...normalizeInvoicePayload(data),
      altId: this.locationId,
      altType: 'location'
    }

    logger.info(`Actualizando recurring invoice schedule activo: ${scheduleId}`)

    return this.request(`/invoices/schedule/${scheduleId}/updateAndSchedule`, {
      method: 'POST',
      body,
      version: GHL_INVOICE_SCHEDULE_API_VERSION
    })
  }

  async getInvoice(invoiceId) {
    return this.request(`/invoices/${invoiceId}`, {
      params: {
        altId: this.locationId,
        altType: 'location',
      }
    })
  }

  async updateInvoice(invoiceId, data) {
    const body = {
      ...normalizeInvoicePayload(data),
      altId: this.locationId,
      altType: 'location',
    }

    logger.info(`Actualizando invoice: ${invoiceId}`)

    const response = await this.request(`/invoices/${invoiceId}`, {
      method: 'PUT',
      body
    })

    logger.success(`Invoice actualizado: ${invoiceId}`)

    return response
  }

  async listInvoices({ limit = 50, offset = 0, contactId } = {}) {
    const params = {
      altId: this.locationId,
      altType: 'location',
      limit,
      offset: offset || 0,
    }

    if (contactId) {
      params.contactId = contactId
    }

    return this.request('/invoices/', { params })
  }

  async voidInvoice(invoiceId) {
    const body = {
      altId: this.locationId,
      altType: 'location',
    }

    logger.info(`Anulando invoice: ${invoiceId}`)

    const response = await this.request(`/invoices/${invoiceId}/void`, {
      method: 'POST',
      body
    })

    logger.success(`Invoice anulado: ${invoiceId}`)

    return response
  }

  async getInvoicePaymentLink(invoiceId, domain = null) {
    // Si hay un domain configurado, usarlo; si no, usar el default de GHL
    if (domain) {
      return `https://${domain}/invoice/${invoiceId}`
    }
    return `https://payments.leadconnectorhq.com/invoice/${invoiceId}`
  }

  async text2Pay(data) {
    const { contactId, amount, currency, message, liveMode = true } = data

    if (!contactId || !amount || !currency) {
      throw new Error('contactId, amount y currency son requeridos para text2Pay')
    }

    logger.info(`Enviando Text2Pay a contacto ${contactId}: ${amount} ${currency}`)

    const body = {
      altId: this.locationId,
      altType: 'location',
      contactId,
      amount,
      currency,
      liveMode,
      ...(message && { message })
    }

    return this.request('/invoices/text2pay', {
      method: 'POST',
      body
    })
  }

  // ============================================
  // USERS
  // ============================================

  async getLocationUsers(locationId) {
    try {
      const locId = locationId || this.locationId
      logger.info(`[GHL Client] Obteniendo usuarios para locationId: ${locId}`)

      // Obtener companyId de la configuración de HighLevel
      const { getHighLevelConfig } = await import('../config/database.js')
      const config = await getHighLevelConfig()

      if (!config || !config.location_data) {
        throw new Error('No se encontró configuración de HighLevel con location_data')
      }

      let locationData
      try {
        locationData = JSON.parse(config.location_data)
      } catch (parseError) {
        throw new Error(`Error al parsear location_data: ${parseError.message}`)
      }

      if (!locationData.companyId) {
        throw new Error('No se encontró companyId en location_data')
      }

      logger.info(`[GHL Client] Usando companyId: ${locationData.companyId}`)

      // API v2 de HighLevel: GET /users/search con query params locationId y companyId (requeridos)
      const data = await this.request('/users/search', {
        params: {
          locationId: locId,
          companyId: locationData.companyId,
          limit: 100, // Máximo permitido por la API
          type: 'account' // Tipo de usuarios a obtener
        }
      })

      const users = data.users || []
      logger.info(`[GHL Client] Usuarios obtenidos: ${users.length}`)

      return users
    } catch (error) {
      logger.error(`[GHL Client] Error al obtener usuarios: ${error.message}`)
      logger.error(`[GHL Client] Stack: ${error.stack}`)
      throw error
    }
  }

  /**
   * Obtener un usuario por su ID
   * @param {string} userId - ID del usuario
   * @returns {Promise<Object>} Usuario
   */
  async getUserById(userId) {
    try {
      logger.info(`🔵 [GHL Client] Obteniendo usuario con ID: ${userId}`)
      logger.info(`🔵 [GHL Client] API Token: ${this.apiToken ? this.apiToken.substring(0, 20) + '...' : 'NO CONFIGURADO'}`)
      logger.info(`🔵 [GHL Client] Location ID: ${this.locationId || 'NO CONFIGURADO'}`)

      // API v2 de HighLevel: GET /users/:userId
      const data = await this.request(`/users/${userId}`)

      logger.info(`🟢 [GHL Client] ✅ Usuario obtenido: ${data.name || data.email || userId}`)
      logger.info(`🟢 [GHL Client] Datos completos del usuario:`, JSON.stringify(data, null, 2))

      return data
    } catch (error) {
      logger.error(`🔴 [GHL Client] ❌ Error al obtener usuario ${userId}: ${error.message}`)
      logger.error(`🔴 [GHL Client] Stack: ${error.stack}`)
      throw error
    }
  }

  /**
   * Obtener múltiples usuarios por sus IDs (para Round Robin teamMembers)
   * @param {string[]} userIds - Array de IDs de usuarios
   * @returns {Promise<Object[]>} Array de usuarios
   */
  async getUsersByIds(userIds) {
    try {
      logger.info(`🔵 [GHL Client] Obteniendo ${userIds.length} usuarios por IDs`)
      logger.info(`🔵 [GHL Client] User IDs a buscar:`, JSON.stringify(userIds))

      // Hacer requests en paralelo para todos los usuarios
      const promises = userIds.map(userId => this.getUserById(userId))
      const users = await Promise.all(promises)

      logger.info(`🟢 [GHL Client] ✅ ${users.length} usuarios obtenidos exitosamente`)
      logger.info(`🟢 [GHL Client] Usuarios obtenidos:`, JSON.stringify(users.map(u => ({ id: u.id, name: u.name, email: u.email }))))

      return users
    } catch (error) {
      logger.error(`🔴 [GHL Client] ❌ Error al obtener usuarios por IDs: ${error.message}`)
      logger.error(`🔴 [GHL Client] Stack: ${error.stack}`)
      throw error
    }
  }
}

/**
 * Obtener una instancia del cliente GHL configurada
 */
export async function getGHLClient() {
  const config = await getHighLevelConfig()

  if (!config || !config.api_token || !config.location_id) {
    throw new Error('Configuración de HighLevel no encontrada. Configura tu integración primero.')
  }

  return new GHLClient(config.api_token, config.location_id)
}

/**
 * Obtiene un contacto por ID
 * @param {string} contactId - ID del contacto
 * @returns {Promise<Object>} - Datos del contacto
 */
export async function getContactById(contactId) {
  const client = await getGHLClient()
  return await client.getContact(contactId)
}

/**
 * Registra un pago en un invoice
 * @param {string} invoiceId - ID del invoice
 * @param {Object} paymentData - Datos del pago
 * @returns {Promise<Object>} - Respuesta de la API
 */
export async function recordPayment(invoiceId, paymentData) {
  const client = await getGHLClient()
  return await client.recordPayment(invoiceId, paymentData)
}

/**
 * Obtiene la lista de usuarios del location
 * @param {string} locationId - ID del location
 * @returns {Promise<Array>} - Lista de usuarios
 */
export async function getLocationUsers(locationId) {
  const client = await getGHLClient()
  return await client.getLocationUsers(locationId)
}

export async function getUserById(userId) {
  const client = await getGHLClient()
  return await client.getUserById(userId)
}

export async function getUsersByIds(userIds) {
  const client = await getGHLClient()
  return await client.getUsersByIds(userIds)
}

export default GHLClient
