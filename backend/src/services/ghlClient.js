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

const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
const GHL_API_VERSION = '2021-07-28'
const MAX_RETRIES = 3
const RETRY_DELAY = 1000 // 1 segundo
const MAX_429_RETRIES = 5
const DEFAULT_429_WAIT_MS = 60000 // 60s si no hay Retry-After header

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
    const { method = 'GET', body, params } = options
    const url = this.buildUrl(endpoint, params)

    let lastError = null
    let retries429 = 0

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Version': GHL_API_VERSION,
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

  // ============================================
  // CONTACTS
  // ============================================

  async searchContacts({ email, phone, query, limit = 20 }) {
    const body = {
      locationId: this.locationId,
    }

    if (email) body.email = email
    if (phone) body.phone = phone
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
      phone: phone,
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

  async updateContact(contactId, data) {
    // Separar nombre completo en firstName y lastName si se proporciona
    const body = { ...data }

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
      params: {
        locationId: this.locationId,
      }
    })
  }

  async listPrices(productId) {
    logger.info(`Obteniendo precios para producto: ${productId}`)

    const response = await this.request(`/products/${productId}/price`, {
      params: {
        locationId: this.locationId,
      }
    })

    return response
  }

  // ============================================
  // INVOICES
  // ============================================

  async createInvoice(data) {
    // Agregar altId en el body para POST requests
    const bodyWithLocation = {
      ...data,
      altId: this.locationId,
      altType: 'location',
    }

    logger.info(`Creando invoice para contacto: ${data.contactDetails?.name || 'N/A'}`)

    const response = await this.request('/invoices/', {
      method: 'POST',
      body: bodyWithLocation,
    })

    logger.success(`Invoice creado: ${response.invoice?.id || response.invoice?._id}`)

    return response
  }

  async recordPayment(invoiceId, { amount, currency, fulfilledAt, note, mode = 'cash' }) {
    const body = {
      altId: this.locationId,
      altType: 'location',
      amount: amount,
      ...(currency ? { currency } : {}),
      notes: note || '',
      fulfilledAt: fulfilledAt || new Date().toISOString(),
      mode,
    }

    logger.info(`Registrando pago para invoice: ${invoiceId} - Monto: ${amount}`)

    const response = await this.request(`/invoices/${invoiceId}/record-payment`, {
      method: 'POST',
      body
    })

    logger.success(`Pago registrado para invoice: ${invoiceId}`)

    return response
  }

  async sendInvoice(invoiceId, options = {}) {
    // Si sendMethod es 'none', no enviar nada (solo crear invoice)
    if (options.sendMethod === 'none') {
      logger.info(`Invoice ${invoiceId} creado pero NO enviado (sendMethod = none)`)
      return { success: true, message: 'Invoice creado pero no enviado' }
    }

    const body = {
      altId: this.locationId,
      altType: 'location',
      action: options.sendMethod || 'email',  // Acepta: 'email', 'sms', 'both', 'none'
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

  async getInvoice(invoiceId) {
    return this.request(`/invoices/${invoiceId}`, {
      params: {
        altId: this.locationId,
        altType: 'location',
      }
    })
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
    const { contactId, amount, currency, message } = data

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
