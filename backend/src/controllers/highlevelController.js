import fetch from 'node-fetch';
import { db } from '../config/database.js';
import { syncHighLevelData, getSyncProgress } from '../services/highlevelSyncService.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import { getGHLClient } from '../services/ghlClient.js';
import { encrypt } from '../utils/encryption.js';
import { buildInvoicePaymentUrl } from '../utils/paymentUrl.js';
import {
  chargePaymentMethod as stripeChargePaymentMethod,
  findCustomerByEmail as stripeFindCustomerByEmail,
  listPaymentMethods as stripeListPaymentMethods
} from '../services/stripeService.js';

/**
 * Prueba la conexión con HighLevel
 */
export const testConnection = async (req, res) => {
  try {
    const { locationId, apiToken } = req.body;

    if (!locationId || !apiToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren locationId y apiToken'
      });
    }

    // Limpiar el token de posibles caracteres no válidos (saltos de línea, tabs, espacios extras)
    const cleanToken = apiToken.trim().replace(/[\r\n\t]/g, '');
    const cleanLocationId = locationId.trim();

    logger.info(`Probando conexión con HighLevel para location: ${cleanLocationId}`);

    // Intentar obtener información de la location
    const response = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(cleanLocationId), {
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Version': '2021-07-28'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Error al conectar con HighLevel: ${errorText}`);
      return res.status(400).json({
        success: false,
        error: 'No se pudo conectar con HighLevel. Verifica tus credenciales.'
      });
    }

    const locationData = await response.json();
    logger.info(`Conexión exitosa con HighLevel: ${locationData.location?.name || 'Location encontrada'}`);

    // Devolver todos los datos del location
    res.json({
      success: true,
      message: 'Conexión exitosa con HighLevel',
      locationData: locationData.location || locationData
    });

  } catch (error) {
    logger.error(`Error en testConnection: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al probar la conexión'
    });
  }
};

/**
 * Limpia todas las tablas de datos (contactos, pagos, citas, anuncios de Meta)
 * Se usa cuando se cambia a un location diferente
 */
async function clearAllData() {
  logger.info('🧹 Limpiando todas las tablas de datos...');

  try {
    // Eliminar en orden para respetar foreign keys
    await db.run('DELETE FROM whatsapp_attribution');
    await db.run('DELETE FROM meta_ads');
    await db.run('DELETE FROM payments');
    await db.run('DELETE FROM appointments');
    await db.run('DELETE FROM contacts');
    await db.run('DELETE FROM meta_config');

    logger.success('✅ Todas las tablas de datos han sido limpiadas');
  } catch (error) {
    logger.error('Error limpiando tablas:', error.message);
    throw error;
  }
}

/**
 * Guarda la configuración de HighLevel y configura webhooks
 */
export const saveConfig = async (req, res) => {
  try {
    const { locationId, apiToken } = req.body;

    if (!locationId || !apiToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren locationId y apiToken'
      });
    }

    // Limpiar el token de posibles caracteres no válidos
    const cleanToken = apiToken.trim().replace(/[\r\n\t]/g, '');
    const cleanLocationId = locationId.trim();

    logger.info(`Guardando configuración de HighLevel para location: ${cleanLocationId}`);

    // Obtener datos del location desde HighLevel
    let locationData = null;
    try {
      const locationResponse = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(cleanLocationId), {
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'Version': '2021-07-28'
        }
      });

      if (locationResponse.ok) {
        const data = await locationResponse.json();
        locationData = data.location || data;
        logger.info(`Datos del location obtenidos: ${locationData.name || 'Sin nombre'}`);
      }
    } catch (error) {
      logger.warn(`No se pudieron obtener datos del location: ${error.message}`);
    }

    // Verificar si existe una configuración con un location_id DIFERENTE
    const existingConfig = await db.get(
      'SELECT location_id FROM highlevel_config LIMIT 1'
    );

    if (existingConfig && existingConfig.location_id !== cleanLocationId) {
      // Es un location DIFERENTE - borrar TODO de la base de datos
      logger.warn(`⚠️ Detectado cambio de location: ${existingConfig.location_id} → ${cleanLocationId}`);
      logger.warn('🗑️ Se eliminarán TODOS los datos existentes para iniciar con el nuevo location');

      await clearAllData();

      // Eliminar la config vieja
      await db.run('DELETE FROM highlevel_config');

      logger.info('✅ Base de datos limpiada completamente. Creando nueva configuración...');
    }

    // Ahora verificar si existe la config para este location específico
    const configForThisLocation = await db.get(
      'SELECT id FROM highlevel_config WHERE location_id = ?',
      [cleanLocationId]
    );

    if (configForThisLocation) {
      // Actualizar configuración existente (mismo location, solo actualiza el token)
      await db.run(
        'UPDATE highlevel_config SET api_token = ?, location_data = ? WHERE location_id = ?',
        [cleanToken, locationData ? JSON.stringify(locationData) : null, cleanLocationId]
      );
      logger.info('Configuración actualizada exitosamente (mismo location)');
    } else {
      // Insertar nueva configuración
      await db.run(
        'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
        [cleanLocationId, cleanToken, locationData ? JSON.stringify(locationData) : null]
      );
      logger.info('Configuración creada exitosamente');
    }

    // Iniciar sincronización automáticamente después de guardar
    logger.info('Iniciando sincronización automática después de guardar configuración');
    syncHighLevelData(cleanLocationId, cleanToken).catch(error => {
      logger.error(`Error en sincronización automática: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Configuración guardada exitosamente. Sincronizando datos...',
      locationData: locationData
    });

  } catch (error) {
    logger.error(`Error en saveConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar la configuración'
    });
  }
};

/**
 * Obtiene la configuración guardada (sin exponer el token completo)
 */
export const getConfig = async (req, res) => {
  try {
    // Intentar obtener config con columnas de invoice
    let config;
    try {
      config = await db.get(
        'SELECT location_id, api_token, location_data, created_at, invoice_title, invoice_number_prefix, invoice_terms_notes, invoice_due_days, transfer_info_url FROM highlevel_config LIMIT 1'
      );
    } catch (selectError) {
      // Si falla (columnas no existen), usar SELECT básico
      config = await db.get(
        'SELECT location_id, api_token, location_data, created_at FROM highlevel_config LIMIT 1'
      );
    }

    if (!config) {
      return res.json({
        configured: false,
        locationId: null,
        hasToken: false,
        apiTokenPreview: null
      });
    }

    const locationDataRaw = config.location_data ? JSON.parse(config.location_data) : null;
    const business = locationDataRaw?.business || {};
    const address = business.address || locationDataRaw?.address || null;
    const city = business.city || locationDataRaw?.city || null;
    const state = business.state || locationDataRaw?.state || null;
    const country = business.country || locationDataRaw?.country || null;
    const postalCode = business.postalCode || locationDataRaw?.postalCode || null;
    const phone = business.phone || locationDataRaw?.phone || null;

    // Crear preview del token (primeros y últimos caracteres)
    const token = config.api_token;
    const tokenPreview = token.length > 20
      ? `${token.substring(0, 10)}${'•'.repeat(8)}${token.substring(token.length - 4)}`
      : `${token.substring(0, 6)}${'•'.repeat(8)}`;

    res.json({
      configured: true,
      locationId: config.location_id,
      hasToken: true,
      apiTokenPreview: tokenPreview,
      updatedAt: config.created_at,
      locationData: locationDataRaw,
      businessName: business.name || locationDataRaw?.name || null,
      businessEmail: business.email || locationDataRaw?.email || null,
      businessPhone: phone || null,
      businessAddress: address || null,
      businessCity: city || null,
      businessState: state || null,
      businessCountry: country || null,
      businessPostalCode: postalCode || null,
      companyLogoUrl: business.logoUrl || locationDataRaw?.logoUrl || null,
      companyWebsite: business.website || locationDataRaw?.website || null,
      domain: locationDataRaw?.domain || null,
      invoiceTitle: config.invoice_title || 'PAGO',
      invoiceNumberPrefix: config.invoice_number_prefix || 'INV-',
      invoiceTermsNotes: config.invoice_terms_notes || null,
      invoiceDueDays: config.invoice_due_days || 7,
      transferInfoUrl: config.transfer_info_url || null
    });

  } catch (error) {
    logger.error(`Error en getConfig: ${error.message}`);
    res.status(500).json({
      configured: false,
      error: 'Error al obtener la configuración'
    });
  }
};

/**
 * Inicia la sincronización completa de datos desde HighLevel
 */
export const syncData = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    );

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      });
    }

    logger.info('Iniciando sincronización de datos desde HighLevel');

    // Iniciar sincronización (no esperar a que termine)
    syncHighLevelData(config.location_id, config.api_token).catch(error => {
      logger.error(`Error en syncHighLevelData: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Sincronización iniciada. Usa getSyncProgress para ver el progreso.'
    });

  } catch (error) {
    logger.error(`Error en syncData: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar la sincronización'
    });
  }
};

/**
 * Obtiene el progreso actual de la sincronización
 */
export const getSyncProgressEndpoint = async (req, res) => {
  try {
    const progress = getSyncProgress();

    res.json({
      success: true,
      progress
    });

  } catch (error) {
    logger.error(`Error en getSyncProgress: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el progreso'
    });
  }
};

/**
 * Revela el token real de API (para uso interno del frontend)
 */
export const revealToken = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT api_token FROM highlevel_config LIMIT 1'
    );

    if (!config || !config.api_token) {
      return res.status(404).json({
        success: false,
        error: 'No se encontró configuración'
      });
    }

    res.json({
      success: true,
      value: config.api_token
    });

  } catch (error) {
    logger.error(`Error en revealToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el token'
    });
  }
};

/**
 * Obtiene el estado de integración de HighLevel
 */
export const getIntegrationStatus = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token, location_data FROM highlevel_config LIMIT 1'
    );

    let highlevelStatus = {
      configured: false,
      connected: false,
      locationId: null,
      locationData: null
    };

    if (config) {
      highlevelStatus.configured = true;
      highlevelStatus.locationId = config.location_id;

      // Parsear los datos del location si existen
      if (config.location_data) {
        try {
          highlevelStatus.locationData = JSON.parse(config.location_data);
        } catch (error) {
          logger.warn('Error parseando location_data:', error.message);
        }
      }

      // Intentar verificar si el token sigue siendo válido
      try {
        const response = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(config.location_id), {
          headers: {
            'Authorization': `Bearer ${config.api_token}`,
            'Version': '2021-07-28'
          }
        });

        if (response.ok) {
          const data = await response.json();
          const locationData = data.location || data;
          highlevelStatus.connected = true;

          // Actualizar datos del location si cambiaron
          if (JSON.stringify(locationData) !== config.location_data) {
            await db.run(
              'UPDATE highlevel_config SET location_data = ? WHERE location_id = ?',
              [JSON.stringify(locationData), config.location_id]
            );
            highlevelStatus.locationData = locationData;
          }
        }
      } catch (error) {
        // Si hay error de red, consideramos que no está conectado
        logger.warn('Error verificando conexión con HighLevel:', error.message);
      }
    }

    // Respuesta con estructura mejorada
    res.json({
      highlevel: highlevelStatus,
      meta: {
        connected: false, // Por ahora siempre false hasta implementar Meta
        configured: false
      }
    });

  } catch (error) {
    logger.error(`Error en getIntegrationStatus: ${error.message}`);
    res.status(500).json({
      highlevel: {
        configured: false,
        connected: false,
        locationId: null,
        locationData: null
      },
      meta: {
        connected: false,
        configured: false
      },
      error: 'Error al obtener el estado de integración'
    });
  }
};

/**
 * Sincroniza custom values para webhooks
 */
export const syncCustomValues = async (req, res) => {
  try {
    const { subaccountId } = req.body;

    if (!subaccountId) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere subaccountId'
      });
    }

    logger.info(`Sincronizando custom values para subaccount: ${subaccountId}`);

    // Por ahora solo registramos la acción
    // En producción aquí se configurarían los webhooks con los custom values

    res.json({
      success: true,
      message: 'Custom values sincronizados exitosamente'
    });

  } catch (error) {
    logger.error(`Error en syncCustomValues: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al sincronizar custom values'
    });
  }
};

/**
 * Sincroniza contactos desde HighLevel
 */
export const syncContacts = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    );

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      });
    }

    logger.info('Iniciando sincronización de contactos desde HighLevel');

    // Iniciar sincronización usando syncHighLevelData del servicio
    syncHighLevelData(config.location_id, config.api_token).catch(error => {
      logger.error(`Error en syncHighLevelData: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Sincronización de contactos iniciada'
    });

  } catch (error) {
    logger.error(`Error en syncContacts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al sincronizar contactos'
    });
  }
};

/**
 * Refresca los datos del location desde HighLevel
 */
export const refreshLocationData = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
    );

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de HighLevel no encontrada'
      });
    }

    logger.info(`Refrescando datos del location: ${config.location_id}`);

    // Obtener datos del location desde HighLevel
    const response = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(config.location_id), {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Error al obtener datos del location: ${errorText}`);
      return res.status(400).json({
        success: false,
        error: 'No se pudo obtener información del location'
      });
    }

    const data = await response.json();
    const locationData = data.location || data;

    // Actualizar en la base de datos
    await db.run(
      'UPDATE highlevel_config SET location_data = ? WHERE location_id = ?',
      [JSON.stringify(locationData), config.location_id]
    );

    logger.info(`Datos del location actualizados: ${locationData.name || 'Sin nombre'}`);

    res.json({
      success: true,
      message: 'Datos del location actualizados',
      locationData: locationData
    });

  } catch (error) {
    logger.error(`Error en refreshLocationData: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al refrescar los datos'
    });
  }
};

/**
 * Elimina la configuración de HighLevel (desconectar)
 */
export const deleteConfig = async (req, res) => {
  try {
    await db.run('DELETE FROM highlevel_config');
    logger.info('Configuración de HighLevel eliminada');

    res.json({
      success: true,
      message: 'Cuenta desconectada exitosamente'
    });

  } catch (error) {
    logger.error(`Error en deleteConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al desconectar la cuenta'
    });
  }
};

/**
 * Obtiene los labels personalizados
 */
export const getCustomLabels = async (req, res) => {
  try {
    const config = await db.get('SELECT custom_labels FROM highlevel_config LIMIT 1');

    // Valores por defecto
    const defaultLabels = {
      customer: 'Cliente',
      customers: 'Clientes',
      lead: 'Interesado',
      leads: 'Interesados'
    };

    let labels = defaultLabels;

    if (config && config.custom_labels) {
      try {
        const parsed = JSON.parse(config.custom_labels);
        labels = { ...defaultLabels, ...parsed };
      } catch (error) {
        logger.warn('Error parsing custom_labels, usando valores por defecto');
      }
    }

    res.json({
      success: true,
      data: labels
    });

  } catch (error) {
    logger.error(`Error en getCustomLabels: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener labels personalizados'
    });
  }
};

/**
 * Actualiza los labels personalizados
 */
export const updateCustomLabels = async (req, res) => {
  try {
    const { customer, customers, lead, leads } = req.body;

    const labels = {
      customer: customer || 'Cliente',
      customers: customers || 'Clientes',
      lead: lead || 'Interesado',
      leads: leads || 'Interesados'
    };

    // Verificar si existe una configuración
    const existingConfig = await db.get('SELECT id FROM highlevel_config LIMIT 1');

    if (existingConfig) {
      // Actualizar
      await db.run(
        'UPDATE highlevel_config SET custom_labels = ? WHERE id = ?',
        [JSON.stringify(labels), existingConfig.id]
      );
    } else {
      // Crear una nueva configuración básica solo con labels
      // Usar NULL en location_id y api_token si no se han configurado
      await db.run(
        'INSERT INTO highlevel_config (location_id, api_token, custom_labels) VALUES (?, ?, ?)',
        [null, null, JSON.stringify(labels)]
      );
    }

    logger.info('Labels personalizados actualizados');

    res.json({
      success: true,
      message: 'Labels actualizados correctamente',
      data: labels
    });

  } catch (error) {
    logger.error(`Error en updateCustomLabels: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar labels personalizados'
    });
  }
};

/**
 * Lista productos de HighLevel
 */
export const listProducts = async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    // Usar GHL Client
    const ghlClient = await getGHLClient();
    const data = await ghlClient.listProducts({ limit: Number(limit) });

    res.json({
      success: true,
      products: data.products || data.data || []
    });

  } catch (error) {
    logger.error(`Error en listProducts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener productos'
    });
  }
};

/**
 * Lista precios de un producto
 */
export const listPrices = async (req, res) => {
  try {
    const { productId } = req.params;

    // Usar GHL Client
    const ghlClient = await getGHLClient();
    const data = await ghlClient.listPrices(productId);

    res.json({
      success: true,
      prices: data.prices || data.data || []
    });

  } catch (error) {
    logger.error(`Error en listPrices: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener precios'
    });
  }
};

/**
 * Crea un invoice en HighLevel
 */
export const createInvoice = async (req, res) => {
  try {
    const invoiceData = req.body;

    // PASO 1: Crear invoice en HighLevel
    const ghlClient = await getGHLClient();
    const data = await ghlClient.createInvoice(invoiceData);

    const createdInvoice = data.invoice || data;
    const ghlInvoiceId = createdInvoice.id || createdInvoice._id;

    if (!ghlInvoiceId) {
      throw new Error('No se pudo obtener el ID del invoice creado');
    }

    logger.success(`Invoice creado en HighLevel: ${ghlInvoiceId}`);

    // PASO 2: Guardar invoice en BD local INMEDIATAMENTE (sin validar contacto)
    const contactId = invoiceData.contactDetails?.id || createdInvoice.contactId;

    try {
      // Calcular monto total
      const items = createdInvoice.items || [];
      const subtotal = items.reduce((sum, item) => sum + (item.amount || 0) * (item.qty || 1), 0);
      const taxAmount = createdInvoice.tax?.amount || 0;
      const total = createdInvoice.total || createdInvoice.amount || (subtotal + taxAmount);

      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method,
          reference, description, date, ghl_invoice_id, invoice_number,
          due_date, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          ghlInvoiceId,
          contactId || null, // Guardar contactId aunque no exista en contacts table
          total,
          createdInvoice.currency || 'MXN',
          'draft', // Inicialmente siempre es draft
          null, // payment_method (se llena cuando se pague)
          createdInvoice.invoiceNumber || null,
          createdInvoice.name || createdInvoice.title || 'Pago',
          createdInvoice.issueDate || createdInvoice.createdAt || new Date().toISOString(),
          ghlInvoiceId,
          createdInvoice.invoiceNumber || null,
          createdInvoice.dueDate || null,
          null // sent_at (se llena cuando se envíe)
        ]
      );

      logger.success(`✅ Invoice guardado en BD local: ${ghlInvoiceId}`);
    } catch (dbError) {
      logger.error(`Error guardando invoice en BD local: ${dbError.message}`);
      // No fallar, el invoice ya se creó en HighLevel
    }

    res.json({
      success: true,
      invoice: createdInvoice
    });

  } catch (error) {
    logger.error(`Error en createInvoice: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al crear invoice'
    });
  }
};

/**
 * Envía un invoice existente (enlace de pago)
 */
export const sendInvoice = async (req, res) => {
  try {
    const { invoiceId } = req.params;

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        error: 'InvoiceId requerido'
      });
    }

    const config = await db.get('SELECT location_data FROM highlevel_config LIMIT 1');
    if (!config || !config.location_data) {
      return res.status(400).json({
        success: false,
        error: 'Configura tu cuenta de HighLevel antes de enviar invoices'
      });
    }

    const locationData = JSON.parse(config.location_data);
    const business = locationData?.business || {};
    const fromName = business.name || locationData?.name || null;
    const fromEmail = business.email || locationData?.email || null;
    const domain = locationData?.domain || null;

    if (!fromName || !fromEmail) {
      return res.status(400).json({
        success: false,
        error: 'Tu perfil de HighLevel requiere nombre y correo del negocio para enviar invoices'
      });
    }

    const ghlClient = await getGHLClient();
    await ghlClient.sendInvoice(invoiceId, {
      sentFrom: {
        fromName,
        fromEmail
      }
    });

    // Actualizar estado en BD local
    try {
      await db.run(
        `UPDATE payments
         SET status = 'sent', sent_at = ?
         WHERE ghl_invoice_id = ?`,
        [new Date().toISOString(), invoiceId]
      );
      logger.success(`Estado actualizado a 'sent' para invoice: ${invoiceId}`);
    } catch (dbError) {
      logger.error(`Error actualizando estado en BD: ${dbError.message}`);
      // No fallar, el invoice ya se envió
    }

    // Construir payment link usando el domain
    const paymentLink = buildInvoicePaymentUrl(domain, invoiceId);

    res.json({
      success: true,
      message: 'Enlace de pago enviado correctamente',
      paymentLink
    });
  } catch (error) {
    logger.error(`Error en sendInvoice: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'No se pudo enviar el invoice'
    });
  }
};

/**
 * Registra un pago offline en HighLevel
 */
export const recordPayment = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const {
      amount,
      currency,
      paymentDate,
      paymentMethod,
      reference,
      notes
    } = req.body;

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        error: 'InvoiceId requerido'
      });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Monto inválido para registrar pago'
      });
    }

    const methodMap = {
      cash: 'cash',
      transfer: 'bank_transfer',
      bank_transfer: 'bank_transfer',
      check: 'check',
      card: 'card',
      other: 'other'
    };

    const methodLabels = {
      cash: 'Efectivo',
      transfer: 'Transferencia',
      bank_transfer: 'Transferencia',
      card: 'Tarjeta',
      check: 'Cheque',
      other: 'Otro'
    };

    const normalizedMethod = paymentMethod || 'cash';
    const mode = methodMap[normalizedMethod] || 'cash';

    const noteParts = [
      `Pago registrado desde Ristak`,
      `Método: ${methodLabels[normalizedMethod] || normalizedMethod}`,
      reference ? `Referencia: ${reference}` : '',
      notes ? `Notas: ${notes}` : ''
    ].filter(Boolean);

    const ghlClient = await getGHLClient();
    await ghlClient.recordPayment(invoiceId, {
      amount,
      currency,
      fulfilledAt: paymentDate || new Date().toISOString(),
      note: noteParts.join('\n'),
      mode
    });

    // Actualizar estado en BD local
    try {
      await db.run(
        `UPDATE payments
         SET status = 'paid', payment_method = ?, reference = ?
         WHERE ghl_invoice_id = ?`,
        [normalizedMethod, reference || null, invoiceId]
      );
      logger.success(`Estado actualizado a 'paid' para invoice: ${invoiceId}`);

      // Actualizar estadísticas del contacto
      const payment = await db.get(
        'SELECT contact_id FROM payments WHERE ghl_invoice_id = ?',
        [invoiceId]
      );

      if (payment && payment.contact_id) {
        const stats = await db.get(
          `SELECT
            SUM(amount) as total_paid,
            COUNT(*) as purchases_count,
            MAX(date) as last_purchase_date
           FROM payments
           WHERE contact_id = ?
           AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')`,
          [payment.contact_id]
        );

        if (stats) {
          await db.run(
            `UPDATE contacts
             SET total_paid = ?, purchases_count = ?, last_purchase_date = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              stats.total_paid || 0,
              stats.purchases_count || 0,
              stats.last_purchase_date || null,
              payment.contact_id
            ]
          );
          logger.success(`Estadísticas actualizadas para contacto: ${payment.contact_id}`);
        }
      }
    } catch (dbError) {
      logger.error(`Error actualizando estado en BD: ${dbError.message}`);
      // No fallar, el pago ya se registró
    }

    res.json({
      success: true,
      message: 'Pago registrado correctamente'
    });

  } catch (error) {
    logger.error(`Error en recordPayment: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al registrar pago'
    });
  }
};

/**
 * Obtiene tarjetas guardadas para un contacto
 */
export const getContactPaymentMethods = async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'contactId es requerido'
      });
    }

    const ghlClient = await getGHLClient();
    const contactResponse = await ghlClient.getContact(contactId);
    const contact = contactResponse?.contact || contactResponse;

    if (!contact || !contact.email) {
      return res.json({
        hasPaymentMethods: false,
        paymentMethods: [],
        message: 'El contacto no tiene email registrado'
      });
    }

    const customer = await stripeFindCustomerByEmail(contact.email);

    if (!customer) {
      return res.json({
        hasPaymentMethods: false,
        paymentMethods: [],
        message: 'El contacto no tiene tarjetas guardadas en Stripe'
      });
    }

    const paymentMethods = await stripeListPaymentMethods(customer.id);
    const formattedMethods = paymentMethods.map((method) => ({
      id: method.id,
      brand: method.card?.brand || 'Desconocido',
      last4: method.card?.last4 || '****',
      expMonth: method.card?.exp_month || 0,
      expYear: method.card?.exp_year || 0,
      createdAt: method.created ? new Date(method.created * 1000).toISOString() : null
    }));

    res.json({
      hasPaymentMethods: formattedMethods.length > 0,
      customerId: customer.id,
      paymentMethods: formattedMethods
    });
  } catch (error) {
    logger.error(`Error en getContactPaymentMethods: ${error.message}`);

    const status = error.message?.includes('Stripe no está configurado') ? 400 : 500;

    res.status(status).json({
      success: false,
      error: error.message || 'Error al buscar tarjetas guardadas'
    });
  }
};

/**
 * Cobra a una tarjeta guardada
 */
export const chargeSavedPaymentMethod = async (req, res) => {
  try {
    const {
      contactId,
      paymentMethodId,
      amount,
      currency,
      invoiceId,
      description
    } = req.body;

    if (!contactId || !paymentMethodId || !amount || Number(amount) <= 0 || !currency) {
      return res.status(400).json({
        success: false,
        error: 'contactId, paymentMethodId, amount y currency son requeridos'
      });
    }

    const ghlClient = await getGHLClient();
    const contactResponse = await ghlClient.getContact(contactId);
    const contact = contactResponse?.contact || contactResponse;

    if (!contact || !contact.email) {
      return res.status(400).json({
        success: false,
        error: 'El contacto no tiene email registrado'
      });
    }

    const customer = await stripeFindCustomerByEmail(contact.email);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'No se encontró un cliente en Stripe para este contacto'
      });
    }

    const paymentIntent = await stripeChargePaymentMethod({
      customerId: customer.id,
      paymentMethodId,
      amount: Number(amount),
      currency,
      description: description || `Cobro manual para ${contact.name || contact.email}`
    });

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        error: 'El pago no se completó',
        status: paymentIntent.status
      });
    }

    if (invoiceId) {
      try {
        await ghlClient.recordPayment(invoiceId, {
          amount,
          currency,
          fulfilledAt: new Date().toISOString(),
          note: `Pago automático con tarjeta guardada (${paymentMethodId})`,
          mode: 'card'
        });
      } catch (recordError) {
        logger.warn(`No se pudo registrar el pago en GHL: ${recordError.message}`);
      }
    }

    res.json({
      success: true,
      paymentIntent: {
        id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status
      }
    });
  } catch (error) {
    logger.error(`Error en chargeSavedPaymentMethod: ${error.message}`);
    const status = error.message?.includes('Stripe no está configurado') ? 400 : 500;

    res.status(status).json({
      success: false,
      error: error.message || 'Error al procesar el pago con tarjeta guardada'
    });
  }
};

/**
 * Busca contactos en HighLevel
 */
export const searchContacts = async (req, res) => {
  try {
    const { query, email, phone, limit = 20 } = req.body;

    // Usar GHL Client
    const ghlClient = await getGHLClient();
    const data = await ghlClient.searchContacts({ query, email, phone, limit: Number(limit) });

    res.json({
      success: true,
      contacts: data.contacts || []
    });

  } catch (error) {
    logger.error(`Error en searchContacts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al buscar contactos'
    });
  }
};

/**
 * Obtiene un contacto por ID de HighLevel
 * GET /api/highlevel/contacts/:id
 */
export const getContactById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere el ID del contacto'
      });
    }

    const ghlClient = await getGHLClient();
    const contact = await ghlClient.request(`/contacts/${id}`);

    res.json({
      success: true,
      contact: contact.contact || contact
    });

  } catch (error) {
    logger.error(`Error en getContactById: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener el contacto'
    });
  }
};

/**
 * Guarda la configuración de Stripe
 * POST /api/highlevel/stripe-config
 */
export const saveStripeConfig = async (req, res) => {
  try {
    const { testSecretKey, liveSecretKey, mode } = req.body;

    // Validaciones básicas
    if (!mode || !['test', 'live'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Modo inválido. Debe ser "test" o "live"'
      });
    }

    // Obtener configuración actual con las keys existentes PRIMERO
    let config;
    try {
      config = await db.get('SELECT id, location_id, stripe_test_secret_key_encrypted, stripe_live_secret_key_encrypted FROM highlevel_config LIMIT 1');
    } catch (e) {
      // Si falla (columnas no existen), obtener solo id y location_id
      config = await db.get('SELECT id, location_id FROM highlevel_config LIMIT 1');
    }

    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes configurar tu cuenta de HighLevel'
      });
    }

    // Verificar si ya hay keys guardadas
    const hasExistingTestKey = !!config.stripe_test_secret_key_encrypted;
    const hasExistingLiveKey = !!config.stripe_live_secret_key_encrypted;

    // Calcular qué keys tendremos DESPUÉS del UPDATE
    // Si se envía testSecretKey !== undefined, usar ese valor (puede ser '' para borrar)
    // Si NO se envía (undefined), mantener el valor existente
    let willHaveTestKey = hasExistingTestKey;
    let willHaveLiveKey = hasExistingLiveKey;

    if (testSecretKey !== undefined) {
      willHaveTestKey = !!testSecretKey.trim();
    }

    if (liveSecretKey !== undefined) {
      willHaveLiveKey = !!liveSecretKey.trim();
    }

    // Caso especial: Si se están borrando AMBAS keys (desconectar), permitirlo sin validación
    const isDeletingAllKeys = (testSecretKey === '' && liveSecretKey === '');

    if (!isDeletingAllKeys) {
      // Validar que existan keys para el modo seleccionado
      if (mode === 'test' && !willHaveTestKey) {
        return res.status(400).json({
          success: false,
          error: 'Se requiere la clave de prueba para modo test. Guarda primero tu Test Secret Key.'
        });
      }

      if (mode === 'live' && !willHaveLiveKey) {
        return res.status(400).json({
          success: false,
          error: 'Se requiere la clave de producción para modo live. Guarda primero tu Live Secret Key.'
        });
      }
    }

    // Encriptar claves solo si se envían Y no están vacías
    // Si se envía string vacío, significa "borrar esta key"
    let encryptedTestKey = null;
    let encryptedLiveKey = null;

    if (testSecretKey !== undefined) {
      // Se envió testSecretKey (puede ser vacío o con valor)
      encryptedTestKey = testSecretKey.trim() ? encrypt(testSecretKey.trim()) : null;
    }

    if (liveSecretKey !== undefined) {
      // Se envió liveSecretKey (puede ser vacío o con valor)
      encryptedLiveKey = liveSecretKey.trim() ? encrypt(liveSecretKey.trim()) : null;
    }

    // Construir UPDATE dinámico: solo actualizar campos que se envían explícitamente
    const updates = [];
    const values = [];

    if (testSecretKey !== undefined) {
      updates.push('stripe_test_secret_key_encrypted = ?');
      values.push(encryptedTestKey); // Puede ser null (borrar) o encrypted (actualizar)
    }

    if (liveSecretKey !== undefined) {
      updates.push('stripe_live_secret_key_encrypted = ?');
      values.push(encryptedLiveKey); // Puede ser null (borrar) o encrypted (actualizar)
    }

    // El modo SIEMPRE se actualiza
    updates.push('stripe_mode = ?');
    values.push(mode);
    values.push(config.location_id);

    const updateSQL = `UPDATE highlevel_config SET ${updates.join(', ')} WHERE location_id = ?`;

    // Intentar actualizar configuración (puede fallar si las columnas no existen)
    try {
      await db.run(updateSQL, values);
    } catch (updateError) {
      // Si falla porque las columnas no existen, agregarlas primero
      logger.error(`Error en UPDATE de Stripe: ${updateError.message}`);

      if (updateError.message.includes('does not exist') || updateError.message.includes('no such column')) {
        logger.warn('🔧 Columnas de Stripe no existen, agregándolas...');

        // Agregar columnas
        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_test_secret_key_encrypted TEXT');
          logger.success('✅ Columna stripe_test_secret_key_encrypted agregada');
        } catch (e) {
          logger.warn(`Columna test key: ${e.message}`);
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_live_secret_key_encrypted TEXT');
          logger.success('✅ Columna stripe_live_secret_key_encrypted agregada');
        } catch (e) {
          logger.warn(`Columna live key: ${e.message}`);
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN stripe_mode TEXT DEFAULT \'test\'');
          logger.success('✅ Columna stripe_mode agregada');
        } catch (e) {
          logger.warn(`Columna mode: ${e.message}`);
        }

        logger.info('🔄 Reintentando UPDATE después de agregar columnas...');

        // Reintentar el UPDATE con el mismo SQL dinámico
        await db.run(updateSQL, values);

        logger.success('✅ UPDATE exitoso después de agregar columnas');
      } else {
        throw updateError;
      }
    }

    logger.info(`Configuración de Stripe guardada para location ${config.location_id} en modo ${mode}`);

    res.json({
      success: true,
      message: 'Configuración de Stripe guardada exitosamente',
      mode: mode
    });

  } catch (error) {
    logger.error(`Error guardando configuración de Stripe: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error guardando configuración de Stripe'
    });
  }
};

/**
 * Obtiene la configuración de Stripe (sin mostrar las claves)
 * GET /api/highlevel/stripe-config
 */
export const getStripeConfig = async (req, res) => {
  try {
    // Intentar obtener config con columnas de Stripe
    let config;
    try {
      config = await db.get(
        'SELECT stripe_mode, stripe_test_secret_key_encrypted, stripe_live_secret_key_encrypted FROM highlevel_config LIMIT 1'
      );
    } catch (selectError) {
      // Si falla (columnas no existen), retornar no configurado
      logger.warn(`Columnas de Stripe no existen todavía: ${selectError.message}`);
      return res.json({
        success: true,
        configured: false,
        mode: null,
        hasTestKey: false,
        hasLiveKey: false
      });
    }

    if (!config) {
      return res.json({
        success: true,
        configured: false,
        mode: null,
        hasTestKey: false,
        hasLiveKey: false
      });
    }

    res.json({
      success: true,
      configured: !!(config.stripe_test_secret_key_encrypted || config.stripe_live_secret_key_encrypted),
      mode: config.stripe_mode || 'test',
      hasTestKey: !!config.stripe_test_secret_key_encrypted,
      hasLiveKey: !!config.stripe_live_secret_key_encrypted
    });

  } catch (error) {
    logger.error(`Error obteniendo configuración de Stripe: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo configuración de Stripe'
    });
  }
};

/**
 * Guarda la configuración de pagos/invoices
 * POST /api/highlevel/invoice-config
 */
export const saveInvoiceConfig = async (req, res) => {
  try {
    const { invoiceTitle, invoiceNumberPrefix, invoiceTermsNotes, invoiceDueDays, transferInfoUrl } = req.body;

    // Validaciones básicas
    if (!invoiceTitle || !invoiceNumberPrefix) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren título y prefijo del documento'
      });
    }

    if (!invoiceDueDays || invoiceDueDays < 1) {
      return res.status(400).json({
        success: false,
        error: 'Los días de vencimiento deben ser al menos 1'
      });
    }

    // Verificar que existe config de HighLevel
    const config = await db.get('SELECT id, location_id FROM highlevel_config LIMIT 1');

    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes configurar tu cuenta de HighLevel'
      });
    }

    // Intentar UPDATE con las columnas de invoice
    const updateSQL = `
      UPDATE highlevel_config
      SET invoice_title = ?,
          invoice_number_prefix = ?,
          invoice_terms_notes = ?,
          invoice_due_days = ?,
          transfer_info_url = ?
      WHERE location_id = ?
    `;

    const values = [
      invoiceTitle.trim(),
      invoiceNumberPrefix.trim(),
      invoiceTermsNotes?.trim() || null,
      parseInt(invoiceDueDays),
      transferInfoUrl?.trim() || null,
      config.location_id
    ];

    try {
      await db.run(updateSQL, values);
    } catch (updateError) {
      // Si falla porque las columnas no existen, agregarlas primero
      if (updateError.message.includes('no such column')) {
        logger.warn('🔧 Columnas de invoice no existen, agregándolas...');

        // Agregar columnas
        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_title TEXT DEFAULT \'PAGO\'');
          logger.success('✅ Columna invoice_title agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_number_prefix TEXT DEFAULT \'INV-\'');
          logger.success('✅ Columna invoice_number_prefix agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_terms_notes TEXT');
          logger.success('✅ Columna invoice_terms_notes agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_due_days INTEGER DEFAULT 7');
          logger.success('✅ Columna invoice_due_days agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN transfer_info_url TEXT');
          logger.success('✅ Columna transfer_info_url agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        logger.info('🔄 Reintentando UPDATE después de agregar columnas...');

        // Reintentar el UPDATE
        await db.run(updateSQL, values);

        logger.success('✅ UPDATE exitoso después de agregar columnas');
      } else {
        throw updateError;
      }
    }

    logger.info(`Configuración de pagos guardada para location ${config.location_id}`);

    res.json({
      success: true,
      message: 'Configuración de pagos guardada exitosamente'
    });

  } catch (error) {
    logger.error(`Error guardando configuración de pagos: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error guardando configuración de pagos'
    });
  }
};

/**
 * Obtiene la lista de usuarios del location de HighLevel
 * GET /api/highlevel/users
 */
export const getLocationUsers = async (req, res) => {
  try {
    const ghlClient = await getGHLClient();
    const config = await db.get('SELECT * FROM highlevel_config LIMIT 1');

    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel activa'
      });
    }

    const users = await ghlClient.getLocationUsers(config.location_id);

    res.json({
      success: true,
      users: users || []
    });

  } catch (error) {
    logger.error(`Error en getLocationUsers: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener usuarios del location'
    });
  }
};

/**
 * Obtener usuarios por IDs (para Round Robin teamMembers)
 * POST /api/highlevel/users/by-ids
 * Body: { userIds: ['id1', 'id2', 'id3'] }
 */
export const getUsersByIds = async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Debes proporcionar un array de userIds'
      });
    }

    const ghlClient = await getGHLClient();
    const users = await ghlClient.getUsersByIds(userIds);

    res.json({
      success: true,
      users: users || []
    });

  } catch (error) {
    logger.error(`Error en getUsersByIds: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener usuarios por IDs'
    });
  }
};
