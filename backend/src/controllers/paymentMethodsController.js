import { db } from '../config/database.js'
import * as stripeService from '../services/stripeService.js'
import * as ghlService from '../services/ghlClient.js'
import { logger } from '../utils/logger.js'

/**
 * GET /api/payment-methods/contact/:contactId
 * Obtiene todas las tarjetas guardadas de un contacto
 */
export async function getContactPaymentMethods(req, res) {
  try {
    const { contactId } = req.params

    // Obtener location_id de la configuración
    const config = await db.get('SELECT location_id FROM highlevel_config LIMIT 1')
    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel. Configura tu cuenta primero.'
      })
    }

    const locationId = config.location_id

    // 1. Obtener datos del contacto desde GHL
    let contact
    try {
      const response = await ghlService.getContactById(contactId)
      // La respuesta de HighLevel viene envuelta en { contact: {...} }
      contact = response?.contact || response

      if (!contact || !contact.email) {
        logger.info(`Contacto ${contactId}: sin email configurado`)
        return res.json({
          success: true,
          hasPaymentMethods: false,
          paymentMethods: [],
          message: 'El contacto no tiene email configurado'
        })
      }
    } catch (error) {
      logger.error('Error obteniendo contacto:', error)
      return res.json({
        success: true,
        hasPaymentMethods: false,
        paymentMethods: [],
        message: 'No se pudo obtener información del contacto'
      })
    }

    // 2. Buscar cliente en Stripe por email
    const stripeCustomer = await stripeService.findCustomerByEmail(locationId, contact.email)

    if (!stripeCustomer) {
      logger.info(`Contacto ${contactId} no tiene customer en Stripe`)
      return res.json({
        success: true,
        hasPaymentMethods: false,
        paymentMethods: [],
        customerId: null,
        message: 'Este contacto no ha pagado con tarjeta anteriormente'
      })
    }

    // 3. Obtener tarjetas del cliente
    const paymentMethods = await stripeService.listPaymentMethods(locationId, stripeCustomer.id)

    // 4. Formatear respuesta
    const formattedMethods = paymentMethods.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'unknown',
      last4: pm.card?.last4 || '****',
      expMonth: pm.card?.exp_month || 0,
      expYear: pm.card?.exp_year || 0,
      fingerprint: pm.card?.fingerprint || ''
    }))

    logger.info(`Encontradas ${formattedMethods.length} tarjetas para contacto ${contactId}`)

    res.json({
      success: true,
      hasPaymentMethods: formattedMethods.length > 0,
      customerId: stripeCustomer.id,
      paymentMethods: formattedMethods
    })
  } catch (error) {
    logger.error('Error obteniendo payment methods:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Error obteniendo métodos de pago'
    })
  }
}

/**
 * POST /api/payment-methods/charge
 * Cobra a una tarjeta guardada
 */
export async function chargePaymentMethod(req, res) {
  try {
    const {
      contactId,
      paymentMethodId,
      amount,
      currency = 'MXN',
      description,
      invoiceId // Opcional: para registrar el pago en un invoice de GHL
    } = req.body

    // Validaciones
    if (!contactId || !paymentMethodId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Faltan datos requeridos: contactId, paymentMethodId, amount'
      })
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      })
    }

    // Obtener location_id
    const config = await db.get('SELECT location_id FROM highlevel_config LIMIT 1')
    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel'
      })
    }

    const locationId = config.location_id

    // Obtener datos del contacto
    const response = await ghlService.getContactById(contactId)
    const contact = response?.contact || response

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Buscar customer en Stripe
    const stripeCustomer = await stripeService.findCustomerByEmail(locationId, contact.email)
    if (!stripeCustomer) {
      return res.status(404).json({
        success: false,
        error: 'El contacto no tiene tarjetas guardadas en Stripe'
      })
    }

    // Cobrar a la tarjeta
    const paymentIntent = await stripeService.chargePaymentMethod(locationId, {
      customerId: stripeCustomer.id,
      paymentMethodId,
      amount,
      currency,
      description: description || `Pago de ${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contactId,
      invoiceId
    })

    // Marcar payment method como usado
    await stripeService.markPaymentMethodAsUsed(paymentMethodId)

    // Si hay un invoice ID, registrar el pago en GHL
    if (invoiceId && paymentIntent.status === 'succeeded') {
      try {
        await ghlService.recordPayment(invoiceId, {
          amount: amount,
          paymentMode: 'Stripe'
        })
        logger.info('Pago registrado en invoice GHL:', invoiceId)
      } catch (error) {
        logger.warn('No se pudo registrar el pago en GHL:', error.message)
        // No fallar la petición si no se pudo registrar en GHL
      }
    }

    res.json({
      success: true,
      paymentIntent: {
        id: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency.toUpperCase(),
        status: paymentIntent.status,
        created: paymentIntent.created
      }
    })
  } catch (error) {
    logger.error('Error cobrando a payment method:', error)

    // Mensajes de error más amigables
    let errorMessage = 'Error procesando el pago'
    if (error.message.includes('card_declined')) {
      errorMessage = 'La tarjeta fue rechazada'
    } else if (error.message.includes('insufficient_funds')) {
      errorMessage = 'Fondos insuficientes'
    } else if (error.message.includes('expired_card')) {
      errorMessage = 'La tarjeta está expirada'
    } else if (error.message.includes('authentication_required')) {
      errorMessage = 'Se requiere autenticación adicional (no disponible para pagos offline)'
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      details: error.message
    })
  }
}

/**
 * POST /api/payment-methods/save
 * Guarda un payment method manualmente (si se obtiene desde webhook)
 */
export async function savePaymentMethod(req, res) {
  try {
    const {
      locationId,
      contactId,
      contactName,
      contactEmail,
      stripeCustomerId,
      stripePaymentMethodId,
      brand,
      last4,
      expMonth,
      expYear,
      isDefault
    } = req.body

    if (!contactId || !stripePaymentMethodId) {
      return res.status(400).json({
        success: false,
        error: 'Faltan datos requeridos'
      })
    }

    const id = await stripeService.savePaymentMethod({
      locationId,
      contactId,
      contactName,
      contactEmail,
      stripeCustomerId,
      stripePaymentMethodId,
      brand,
      last4,
      expMonth,
      expYear,
      isDefault
    })

    res.json({
      success: true,
      id
    })
  } catch (error) {
    logger.error('Error guardando payment method:', error)
    res.status(500).json({
      success: false,
      error: 'Error guardando método de pago'
    })
  }
}
