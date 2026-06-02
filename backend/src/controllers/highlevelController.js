import fetch from 'node-fetch';
import { db } from '../config/database.js';
import { syncHighLevelData, getSyncProgress } from '../services/highlevelSyncService.js';
import { syncSingleInvoice } from '../services/invoicesSyncService.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import { getGHLClient } from '../services/ghlClient.js';
import { buildInvoicePaymentUrl } from '../utils/paymentUrl.js';
import { createInstallmentPaymentFlow } from '../services/paymentFlowService.js';
import { formatInvoiceMultilineText, formatInvoicePayloadText } from '../utils/invoiceTextFormatter.js';
import { normalizePhoneForStorage } from '../utils/phoneUtils.js';

const normalizeGhlInvoiceMode = (mode) => mode === 'test' ? 'test' : 'live';
const INACTIVE_INVOICE_SCHEDULE_STATUSES = new Set([
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'deleted',
  'draft',
  'expired',
  'failed',
  'inactive',
  'paused',
  'void'
]);

async function getGhlInvoiceMode() {
  try {
    const config = await db.get('SELECT ghl_invoice_mode FROM highlevel_config LIMIT 1');
    return normalizeGhlInvoiceMode(config?.ghl_invoice_mode);
  } catch {
    return 'live';
  }
}

async function getGhlInvoiceLiveMode() {
  return (await getGhlInvoiceMode()) === 'live';
}

function getInvoiceItems(invoice = {}, fallbackInvoice = {}) {
  const itemSources = [
    invoice.invoiceItems,
    invoice.items,
    invoice.lineItems,
    fallbackInvoice.invoiceItems,
    fallbackInvoice.items,
    fallbackInvoice.lineItems
  ];

  for (const source of itemSources) {
    if (Array.isArray(source) && source.length > 0) return source;
  }

  return [];
}

function getInvoiceDisplayDescription(invoice = {}, fallbackInvoice = {}) {
  const firstItem = getInvoiceItems(invoice, fallbackInvoice)[0] || {};

  return firstDefined(
    firstItem.description,
    firstItem.name,
    invoice.description,
    fallbackInvoice.description,
    invoice.name,
    invoice.title,
    fallbackInvoice.name,
    fallbackInvoice.title,
    'Pago'
  );
}

function getInvoiceDisplayTitle(invoice = {}, fallbackInvoice = {}) {
  const firstItem = getInvoiceItems(invoice, fallbackInvoice)[0] || {};

  return firstDefined(
    invoice.title,
    invoice.name,
    fallbackInvoice.title,
    fallbackInvoice.name,
    firstItem.name,
    firstItem.description,
    'Pago'
  );
}

async function getGhlInvoiceScheduleContext() {
  const config = await db.get(`
    SELECT location_data, ghl_invoice_mode, invoice_title, invoice_terms_notes, invoice_number_prefix
    FROM highlevel_config
    LIMIT 1
  `);

  const locationData = config?.location_data
    ? safeJsonParse(config.location_data, {})
    : {};
  const business = locationData?.business || {};

  return {
    liveMode: normalizeGhlInvoiceMode(config?.ghl_invoice_mode) === 'live',
    currency: firstDefined(
      locationData?.currency,
      locationData?.currencyCode,
      locationData?.currency_code,
      business?.currency,
      business?.currencyCode,
      'MXN'
    ),
    invoiceTitle: config?.invoice_title || 'PLAN DE PAGO',
    termsNotes: formatInvoiceMultilineText(config?.invoice_terms_notes || null),
    invoiceNumberPrefix: config?.invoice_number_prefix || null,
    businessDetails: {
      name: business.name || locationData?.name || 'Mi Negocio',
      phoneNo: business.phone || locationData?.phone || '',
      website: business.website || locationData?.website || '',
      address: business.address || locationData?.address || '',
      city: business.city || locationData?.city || '',
      state: business.state || locationData?.state || '',
      country: business.country || locationData?.country || '',
      countryCode: business.countryCode || locationData?.countryCode || '',
      postalCode: business.postalCode || locationData?.postalCode || ''
    }
  };
}

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
        'SELECT location_id, api_token, location_data, created_at, invoice_title, invoice_number_prefix, invoice_terms_notes, invoice_due_days, transfer_info_url, card_setup_amount, ghl_invoice_mode FROM highlevel_config LIMIT 1'
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
      invoiceTermsNotes: formatInvoiceMultilineText(config.invoice_terms_notes || null) || null,
      invoiceDueDays: config.invoice_due_days || 7,
      transferInfoUrl: config.transfer_info_url || null,
      cardSetupAmount: config.card_setup_amount || 25,
      ghlInvoiceMode: normalizeGhlInvoiceMode(config.ghl_invoice_mode),
      ghlInvoiceLiveMode: normalizeGhlInvoiceMode(config.ghl_invoice_mode) === 'live'
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
    const liveMode = await getGhlInvoiceLiveMode();
    const paymentMode = liveMode ? 'live' : 'test';
    const invoiceData = formatInvoicePayloadText({
      ...(req.body || {}),
      liveMode
    });

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

      const displayTitle = getInvoiceDisplayTitle(createdInvoice, invoiceData);
      const displayDescription = getInvoiceDisplayDescription(createdInvoice, invoiceData);

      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          reference, title, description, date, ghl_invoice_id, invoice_number,
          due_date, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          contact_id = excluded.contact_id,
          amount = excluded.amount,
          currency = excluded.currency,
          status = excluded.status,
          payment_mode = excluded.payment_mode,
          reference = excluded.reference,
          title = excluded.title,
          description = excluded.description,
          date = excluded.date,
          ghl_invoice_id = excluded.ghl_invoice_id,
          invoice_number = excluded.invoice_number,
          due_date = excluded.due_date,
          updated_at = CURRENT_TIMESTAMP`,
        [
          ghlInvoiceId,
          contactId || null, // Guardar contactId aunque no exista en contacts table
          total,
          createdInvoice.currency || 'MXN',
          'draft', // Inicialmente siempre es draft
          null, // payment_method (se llena cuando se pague)
          paymentMode,
          createdInvoice.invoiceNumber || null,
          displayTitle,
          displayDescription,
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
    const { sendMethod = 'email' } = req.body;

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        error: 'InvoiceId requerido'
      });
    }

    const config = await db.get('SELECT location_data, ghl_invoice_mode FROM highlevel_config LIMIT 1');
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

    const liveMode = normalizeGhlInvoiceMode(config.ghl_invoice_mode) === 'live';

    const ghlClient = await getGHLClient();
    await ghlClient.sendInvoice(invoiceId, {
      sentFrom: {
        fromName,
        fromEmail
      },
      sendMethod: sendMethod,
      liveMode: liveMode
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

    // Mensaje personalizado según el método de envío
    let message = '';
    if (sendMethod === 'none') {
      message = 'Invoice creado. Debes enviarlo manualmente al cliente.';
    } else if (sendMethod === 'sms') {
      message = 'Invoice enviado por WhatsApp';
    } else if (sendMethod === 'both') {
      message = 'Invoice enviado por email y WhatsApp';
    } else {
      message = 'Invoice enviado por email';
    }

    res.json({
      success: true,
      message: message,
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
    const liveMode = await getGhlInvoiceLiveMode();
    const paymentMode = liveMode ? 'live' : 'test';

    const noteParts = [
      `Pago registrado desde Ristak`,
      `Método: ${methodLabels[normalizedMethod] || normalizedMethod}`,
      paymentMode === 'test' ? 'Modo: prueba' : '',
      reference ? `Referencia: ${reference}` : '',
      notes ? `Notas: ${notes}` : ''
    ].filter(Boolean);

    const ghlClient = await getGHLClient();
    await ghlClient.recordPayment(invoiceId, {
      amount,
      currency,
      fulfilledAt: paymentDate || new Date().toISOString(),
      note: noteParts.join('\n'),
      mode,
      liveMode
    });

    // Actualizar estado en BD local
    try {
      await db.run(
        `UPDATE payments
         SET status = 'paid', payment_method = ?, reference = ?, payment_mode = ?, updated_at = CURRENT_TIMESTAMP
         WHERE ghl_invoice_id = ?`,
        [normalizedMethod, reference || null, paymentMode, invoiceId]
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
           AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
           AND COALESCE(payment_mode, 'live') != 'test'`,
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
 * Crea un flujo de cobro por parcialidades.
 * Regla dura: los pagos automáticos quedan esperando tarjeta autorizada.
 */
export const createInstallmentFlow = async (req, res) => {
  try {
    const result = await createInstallmentPaymentFlow(req.body);

    res.json({
      success: true,
      message: 'Flujo de parcialidades creado correctamente',
      ...result
    });
  } catch (error) {
    logger.error(`Error en createInstallmentFlow: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'No se pudo crear el flujo de parcialidades'
    });
  }
};

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractScheduleList(response) {
  if (Array.isArray(response)) return response;

  const candidates = [
    response?.schedules,
    response?.invoiceSchedules,
    response?.invoice_schedules,
    response?.data?.schedules,
    response?.data?.invoiceSchedules,
    response?.data?.invoice_schedules,
    response?.data,
    response?.items,
    response?.results
  ];

  return candidates.find(Array.isArray) || [];
}

function extractScheduleFromResponse(response) {
  if (!response) return null;
  if (Array.isArray(response)) return response[0] || null;

  const candidate = firstDefined(
    response.schedule,
    response.invoiceSchedule,
    response.invoice_schedule,
    response.data?.schedule,
    response.data?.invoiceSchedule,
    response.data?.invoice_schedule,
    response.data,
    response
  );

  if (Array.isArray(candidate)) return candidate[0] || null;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

function combineRruleStart(rrule = {}) {
  if (!rrule || typeof rrule !== 'object') return null;
  if (!rrule.startDate) return null;

  if (!rrule.startTime) return rrule.startDate;

  const time = String(rrule.startTime);
  return `${rrule.startDate}T${time.length === 5 ? `${time}:00` : time}`;
}

function resolveScheduleObject(schedule = {}) {
  return schedule.schedule && typeof schedule.schedule === 'object'
    ? schedule.schedule
    : {};
}

function resolveScheduleRecurrence(schedule = {}) {
  const scheduleConfig = resolveScheduleObject(schedule);
  return firstDefined(
    scheduleConfig.rrule,
    schedule.rrule,
    schedule.recurrence,
    schedule.recurring,
    scheduleConfig.recurrence
  ) || null;
}

function resolveSchedulePrimaryDate(schedule = {}) {
  const scheduleConfig = resolveScheduleObject(schedule);
  const rrule = resolveScheduleRecurrence(schedule);

  return firstDefined(
    schedule.nextRunAt,
    schedule.next_run_at,
    schedule.nextInvoiceDate,
    schedule.next_invoice_date,
    schedule.nextExecutionAt,
    schedule.next_execution_at,
    schedule.nextScheduleAt,
    schedule.next_schedule_at,
    schedule.nextDate,
    schedule.next_date,
    scheduleConfig.executeAt,
    scheduleConfig.execute_at,
    combineRruleStart(rrule),
    schedule.startDate,
    schedule.start_date,
    schedule.dueDate,
    schedule.due_date,
    schedule.updatedAt,
    schedule.updated_at,
    schedule.createdAt,
    schedule.created_at
  ) || null;
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveScheduleTotal(schedule = {}) {
  const direct = numberOrNull(firstDefined(
    schedule.total,
    schedule.amount,
    schedule.grandTotal,
    schedule.grand_total,
    schedule.invoiceTotal,
    schedule.invoice_total,
    schedule.balance
  ));

  if (direct !== null) return direct;

  const items = toArray(firstDefined(schedule.items, schedule.invoiceItems, schedule.lineItems));
  const itemsTotal = items.reduce((sum, item) => {
    const amount = numberOrNull(firstDefined(item.amount, item.price, item.unitAmount, item.unit_amount)) || 0;
    const qty = numberOrNull(firstDefined(item.qty, item.quantity)) || 1;
    return sum + amount * qty;
  }, 0);

  return itemsTotal > 0 ? Math.round(itemsTotal * 100) / 100 : 0;
}

function resolveContactDetails(schedule = {}) {
  return firstDefined(
    schedule.contactDetails,
    schedule.contact,
    schedule.customer,
    schedule.client
  ) || {};
}

function resolveContactName(contact = {}) {
  return firstDefined(
    contact.name,
    contact.fullName,
    contact.full_name,
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim(),
    contact.email,
    contact.phone,
    ''
  );
}

function resolveRecurrenceLabel(schedule = {}) {
  const recurrence = resolveScheduleRecurrence(schedule);
  const intervalType = recurrence?.intervalType || recurrence?.frequency || schedule.frequency || schedule.intervalType;
  const interval = recurrence?.interval || schedule.interval || 1;

  if (!intervalType) return 'Sin recurrencia';

  const labels = {
    daily: 'Diario',
    weekly: 'Semanal',
    monthly: 'Mensual',
    yearly: 'Anual',
    custom: 'Personalizado'
  };

  const baseLabel = labels[String(intervalType).toLowerCase()] || String(intervalType);
  return Number(interval) > 1 ? `${baseLabel} cada ${interval}` : baseLabel;
}

function normalizeScheduleStatus(value) {
  return value ? String(value).toLowerCase() : 'active';
}

function isActiveInvoiceSchedule(schedule = {}) {
  const status = normalizeScheduleStatus(firstDefined(
    schedule.status,
    schedule.scheduleStatus,
    schedule.schedule_status,
    schedule.state
  ));

  return !INACTIVE_INVOICE_SCHEDULE_STATUSES.has(status);
}

function normalizeInvoiceSchedule(schedule = {}) {
  const id = firstDefined(schedule.id, schedule._id, schedule.scheduleId, schedule.schedule_id);
  const contact = resolveContactDetails(schedule);
  const scheduleConfig = resolveScheduleObject(schedule);
  const recurrence = resolveScheduleRecurrence(schedule);
  const primaryDate = resolveSchedulePrimaryDate(schedule);
  const items = toArray(firstDefined(schedule.items, schedule.invoiceItems, schedule.lineItems));
  const status = normalizeScheduleStatus(firstDefined(
    schedule.status,
    schedule.scheduleStatus,
    schedule.schedule_status,
    schedule.state
  ));

  return {
    id,
    name: firstDefined(schedule.name, schedule.title, schedule.invoiceName, schedule.invoice_name, 'Plan de pago'),
    title: firstDefined(schedule.title, schedule.name, 'Plan de pago'),
    status,
    total: resolveScheduleTotal(schedule),
    currency: firstDefined(schedule.currency, scheduleConfig.currency, 'MXN'),
    contactId: firstDefined(contact.id, contact._id, schedule.contactId, schedule.contact_id),
    contactName: resolveContactName(contact),
    email: firstDefined(contact.email, schedule.email, ''),
    phone: firstDefined(contact.phoneNo, contact.phone, schedule.phone, ''),
    description: firstDefined(
      items[0]?.description,
      items[0]?.name,
      schedule.description,
      schedule.termsNotes,
      ''
    ),
    startDate: firstDefined(
      schedule.startDate,
      schedule.start_date,
      scheduleConfig.startDate,
      recurrence?.startDate,
      combineRruleStart(recurrence)
    ),
    nextRunAt: primaryDate,
    endDate: firstDefined(
      schedule.endDate,
      schedule.end_date,
      scheduleConfig.endDate,
      recurrence?.endDate
    ),
    recurrenceLabel: resolveRecurrenceLabel(schedule),
    liveMode: schedule.liveMode,
    itemCount: items.length,
    createdAt: firstDefined(schedule.createdAt, schedule.created_at),
    updatedAt: firstDefined(schedule.updatedAt, schedule.updated_at),
    sortDate: primaryDate || firstDefined(schedule.updatedAt, schedule.updated_at, schedule.createdAt, schedule.created_at),
    raw: schedule
  };
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function booleanToDb(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function dbToBoolean(value) {
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
}

async function persistLocalInvoiceSchedule(schedule) {
  if (!schedule?.id) return;

  const raw = schedule.raw && typeof schedule.raw === 'object' ? schedule.raw : schedule;
  const scheduleConfig = resolveScheduleObject(raw);

  try {
    await db.run(
      `INSERT INTO payment_plans (
        id, ghl_schedule_id, contact_id, contact_name, email, phone,
        name, title, status, total, currency, description, recurrence_label,
        start_date, next_run_at, end_date, live_mode, item_count,
        schedule_json, raw_json, source, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ghl', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        ghl_schedule_id = excluded.ghl_schedule_id,
        contact_id = excluded.contact_id,
        contact_name = excluded.contact_name,
        email = excluded.email,
        phone = excluded.phone,
        name = excluded.name,
        title = excluded.title,
        status = excluded.status,
        total = excluded.total,
        currency = excluded.currency,
        description = excluded.description,
        recurrence_label = excluded.recurrence_label,
        start_date = excluded.start_date,
        next_run_at = excluded.next_run_at,
        end_date = excluded.end_date,
        live_mode = excluded.live_mode,
        item_count = excluded.item_count,
        schedule_json = excluded.schedule_json,
        raw_json = excluded.raw_json,
        source = excluded.source,
        last_synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [
        schedule.id,
        schedule.id,
        schedule.contactId || null,
        schedule.contactName || null,
        schedule.email || null,
        normalizePhoneForStorage(schedule.phone) || schedule.phone || null,
        schedule.name || null,
        schedule.title || null,
        schedule.status || null,
        Number(schedule.total || 0),
        schedule.currency || null,
        schedule.description || null,
        schedule.recurrenceLabel || null,
        schedule.startDate || null,
        schedule.nextRunAt || null,
        schedule.endDate || null,
        booleanToDb(schedule.liveMode),
        Number(schedule.itemCount || 0),
        JSON.stringify(scheduleConfig || {}),
        JSON.stringify(raw || {}),
        schedule.createdAt || null
      ]
    );
  } catch (error) {
    logger.warn(`No se pudo guardar plan de pago local ${schedule.id}: ${error.message}`);
  }
}

async function persistLocalInvoiceSchedules(schedules = []) {
  for (const schedule of schedules) {
    await persistLocalInvoiceSchedule(schedule);
  }
}

function paymentPlanFromRow(row = {}) {
  const raw = safeJsonParse(row.raw_json, {});

  return {
    id: row.id || row.ghl_schedule_id,
    name: row.name || row.title || 'Plan de pago',
    title: row.title || row.name || 'Plan de pago',
    status: row.status || 'active',
    total: Number(row.total || 0),
    currency: row.currency || 'MXN',
    contactId: row.contact_id || undefined,
    contactName: row.contact_name || '',
    email: row.email || '',
    phone: row.phone || '',
    description: row.description || '',
    startDate: row.start_date || undefined,
    nextRunAt: row.next_run_at || undefined,
    endDate: row.end_date || undefined,
    recurrenceLabel: row.recurrence_label || 'Sin recurrencia',
    liveMode: dbToBoolean(row.live_mode),
    itemCount: Number(row.item_count || 0),
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
    sortDate: row.next_run_at || row.updated_at || row.created_at,
    raw: raw && Object.keys(raw).length ? raw : {
      id: row.id || row.ghl_schedule_id,
      schedule: safeJsonParse(row.schedule_json, {})
    }
  };
}

async function listLocalInvoiceSchedules({ activeOnly = false } = {}) {
  const where = activeOnly
    ? `WHERE LOWER(COALESCE(status, 'active')) NOT IN (${Array.from(INACTIVE_INVOICE_SCHEDULE_STATUSES).map(() => '?').join(', ')})`
    : '';
  const params = activeOnly ? Array.from(INACTIVE_INVOICE_SCHEDULE_STATUSES) : [];
  const rows = await db.all(
    `SELECT * FROM payment_plans ${where}
     ORDER BY COALESCE(next_run_at, updated_at, created_at) DESC`,
    params
  );

  return rows.map(paymentPlanFromRow);
}

async function getLocalInvoiceSchedule(scheduleId) {
  const row = await db.get(
    'SELECT * FROM payment_plans WHERE id = ? OR ghl_schedule_id = ? LIMIT 1',
    [scheduleId, scheduleId]
  );

  return row ? paymentPlanFromRow(row) : null;
}

async function markLocalInvoiceScheduleStatus(scheduleId, status, rawPatch = {}) {
  const now = new Date().toISOString();
  const existing = await getLocalInvoiceSchedule(scheduleId);
  const existingRaw = existing?.raw && typeof existing.raw === 'object' ? existing.raw : {};
  const raw = {
    ...existingRaw,
    ...rawPatch,
    id: existing?.id || existingRaw.id || scheduleId,
    _id: existingRaw._id || scheduleId,
    status,
    scheduleStatus: status,
    state: status,
    updatedAt: now
  };

  const updatedSchedule = existing
    ? {
      ...existing,
      id: existing.id || scheduleId,
      status,
      updatedAt: now,
      sortDate: existing.sortDate || now,
      raw
    }
    : normalizeInvoiceSchedule(raw);

  await persistLocalInvoiceSchedule(updatedSchedule);
  return updatedSchedule;
}

async function getInvoiceScheduleMutationSource(ghlClient, scheduleId) {
  try {
    const detailResponse = await ghlClient.getInvoiceSchedule(scheduleId);
    const schedule = extractScheduleFromResponse(detailResponse);
    if (schedule) return schedule;
  } catch (error) {
    logger.warn(`No se pudo leer schedule ${scheduleId} desde GHL antes de mutarlo: ${error.message}`);
  }

  const localSchedule = await getLocalInvoiceSchedule(scheduleId);
  return localSchedule?.raw || {};
}

async function normalizePersistedInvoiceScheduleAction(ghlClient, scheduleId, response, fallbackStatus, rawPatch = {}) {
  let schedule = extractScheduleFromResponse(response);

  if (!schedule) {
    try {
      const detailResponse = await ghlClient.getInvoiceSchedule(scheduleId);
      schedule = extractScheduleFromResponse(detailResponse);
    } catch (error) {
      logger.warn(`Acción aplicada a schedule ${scheduleId}, pero no se pudo refrescar detalle: ${error.message}`);
    }
  }

  if (schedule) {
    const normalizedSchedule = normalizeInvoiceSchedule(schedule);
    await persistLocalInvoiceSchedule(normalizedSchedule);
    return normalizedSchedule;
  }

  if (fallbackStatus) {
    return markLocalInvoiceScheduleStatus(scheduleId, fallbackStatus, rawPatch);
  }

  const localSchedule = await getLocalInvoiceSchedule(scheduleId);
  if (localSchedule) return localSchedule;

  const normalizedSchedule = normalizeInvoiceSchedule({ id: scheduleId, ...rawPatch });
  await persistLocalInvoiceSchedule(normalizedSchedule);
  return normalizedSchedule;
}

function sanitizeInvoiceSchedulePayload(payload = {}) {
  const sanitized = { ...payload };
  delete sanitized.raw;
  delete sanitized.sortDate;
  delete sanitized.recurrenceLabel;
  delete sanitized.itemCount;
  delete sanitized.statusLabel;
  return sanitized;
}

export const createInvoiceSchedule = async (req, res) => {
  try {
    const rawPayload = req.body?.payload && typeof req.body.payload === 'object'
      ? req.body.payload
      : req.body;
    const context = await getGhlInvoiceScheduleContext();
    const currency = String(firstDefined(rawPayload?.currency, context.currency, 'MXN')).toUpperCase();
    const items = toArray(firstDefined(rawPayload?.items, rawPayload?.invoiceItems)).map(item => ({
      ...item,
      currency: item.currency || currency
    }));
    const payload = formatInvoicePayloadText(sanitizeInvoiceSchedulePayload({
      ...rawPayload,
      status: rawPayload?.status || 'draft',
      liveMode: rawPayload?.liveMode !== undefined ? rawPayload.liveMode : context.liveMode,
      currency,
      title: rawPayload?.title || context.invoiceTitle,
      termsNotes: firstDefined(rawPayload?.termsNotes, context.termsNotes),
      ...(context.invoiceNumberPrefix && !rawPayload?.invoiceNumberPrefix ? { invoiceNumberPrefix: context.invoiceNumberPrefix } : {}),
      businessDetails: rawPayload?.businessDetails || context.businessDetails,
      amountPaid: numberOrNull(rawPayload?.amountPaid) || 0,
      amountDue: numberOrNull(rawPayload?.amountDue) || Number(rawPayload?.total || 0),
      issueDate: rawPayload?.issueDate || rawPayload?.schedule?.rrule?.startDate || String(rawPayload?.schedule?.executeAt || '').slice(0, 10),
      dueDate: rawPayload?.dueDate || rawPayload?.schedule?.rrule?.startDate || String(rawPayload?.schedule?.executeAt || '').slice(0, 10),
      ...(items.length ? { items, invoiceItems: rawPayload?.invoiceItems || items } : {})
    }));
    const shouldSchedule = req.body?.scheduleNow !== false;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({
        success: false,
        error: 'Payload inválido para crear plan de pago'
      });
    }

    if (!payload.contactDetails?.id) {
      return res.status(400).json({
        success: false,
        error: 'Selecciona un contacto para crear el plan de pago'
      });
    }

    if (!payload.total || Number(payload.total) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Monto inválido para crear plan de pago'
      });
    }

    if (!payload.schedule?.executeAt && !payload.schedule?.rrule?.startDate) {
      return res.status(400).json({
        success: false,
        error: 'Fecha de programación requerida'
      });
    }

    const ghlClient = await getGHLClient();
    const createResponse = await ghlClient.createInvoiceSchedule(payload);
    let schedule = extractScheduleFromResponse(createResponse);
    let scheduleId = firstDefined(
      schedule?.id,
      schedule?._id,
      schedule?.scheduleId,
      schedule?.schedule_id,
      createResponse?.id,
      createResponse?._id,
      createResponse?.scheduleId,
      createResponse?.schedule_id,
      createResponse?.data?.id,
      createResponse?.data?._id,
      createResponse?.schedule?.id,
      createResponse?.invoiceSchedule?.id
    );

    if (!scheduleId) {
      throw new Error('HighLevel no devolvió ID del plan de pago creado');
    }

    if (shouldSchedule) {
      await ghlClient.scheduleInvoiceSchedule(scheduleId, {
        liveMode: payload.liveMode
      });

      try {
        const detailResponse = await ghlClient.getInvoiceSchedule(scheduleId);
        schedule = extractScheduleFromResponse(detailResponse) || schedule;
      } catch (detailError) {
        logger.warn(`Plan ${scheduleId} creado, pero no se pudo refrescar detalle: ${detailError.message}`);
      }
    }

    const normalizedSchedule = normalizeInvoiceSchedule(schedule || {
      ...payload,
      id: scheduleId
    });
    await persistLocalInvoiceSchedule(normalizedSchedule);

    res.json({
      success: true,
      data: normalizedSchedule
    });
  } catch (error) {
    logger.error(`Error creando invoice schedule: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al crear plan de pago'
    });
  }
};

export const listInvoiceSchedules = async (req, res) => {
  try {
    const activeOnly = req.query.activeOnly === 'true';
    const requestedLimit = Number(req.query.limit);
    const singlePage = Number.isFinite(requestedLimit) && requestedLimit > 0;
    const limit = Math.min(singlePage ? requestedLimit : 100, 100);
    let offset = Math.max(Number(req.query.offset) || 0, 0);
    const maxPages = singlePage ? 1 : 10;
    const schedules = [];

    const ghlClient = await getGHLClient();

    for (let page = 0; page < maxPages; page += 1) {
      const response = await ghlClient.listInvoiceSchedules({ limit, offset });
      const pageSchedules = extractScheduleList(response);
      schedules.push(...pageSchedules);

      if (pageSchedules.length < limit) break;
      offset += limit;
    }

    const data = schedules
      .filter(schedule => !activeOnly || isActiveInvoiceSchedule(schedule))
      .map(normalizeInvoiceSchedule)
      .filter(schedule => schedule.id)
      .sort((left, right) => timestamp(right.sortDate) - timestamp(left.sortDate));

    await persistLocalInvoiceSchedules(data);

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.warn(`No se pudo sincronizar invoice schedules desde GHL; usando cache local si existe: ${error.message}`);

    try {
      const data = await listLocalInvoiceSchedules({
        activeOnly: req.query.activeOnly === 'true'
      });

      if (data.length > 0) {
        return res.json({
          success: true,
          data,
          source: 'local_cache'
        });
      }
    } catch (localError) {
      logger.error(`Error leyendo cache local de invoice schedules: ${localError.message}`);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener planes de pago'
    });
  }
};

export const getInvoiceSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;

    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        error: 'scheduleId requerido'
      });
    }

    const ghlClient = await getGHLClient();
    const response = await ghlClient.getInvoiceSchedule(scheduleId);
    const schedule = extractScheduleFromResponse(response);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: 'Plan de pago no encontrado'
      });
    }

    const normalizedSchedule = normalizeInvoiceSchedule(schedule);
    await persistLocalInvoiceSchedule(normalizedSchedule);

    res.json({
      success: true,
      data: normalizedSchedule
    });
  } catch (error) {
    logger.warn(`No se pudo obtener invoice schedule ${req.params.scheduleId} desde GHL; intentando cache local: ${error.message}`);

    try {
      const localSchedule = await getLocalInvoiceSchedule(req.params.scheduleId);
      if (localSchedule) {
        return res.json({
          success: true,
          data: localSchedule,
          source: 'local_cache'
        });
      }
    } catch (localError) {
      logger.error(`Error leyendo plan local ${req.params.scheduleId}: ${localError.message}`);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener plan de pago'
    });
  }
};

export const updateInvoiceSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const rawPayload = req.body?.payload && typeof req.body.payload === 'object'
      ? req.body.payload
      : req.body;
    const payload = sanitizeInvoiceSchedulePayload(rawPayload);
    const shouldUpdateScheduled = req.body?.updateAndSchedule !== false;

    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        error: 'scheduleId requerido'
      });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Payload inválido para actualizar plan de pago'
      });
    }

    const ghlClient = await getGHLClient();
    let response;

    try {
      response = shouldUpdateScheduled
        ? await ghlClient.updateAndScheduleInvoiceSchedule(scheduleId, payload)
        : await ghlClient.updateInvoiceSchedule(scheduleId, payload);
    } catch (scheduledError) {
      if (!shouldUpdateScheduled) {
        throw scheduledError;
      }

      logger.warn(`No se pudo usar updateAndSchedule para ${scheduleId}; intentando PUT normal: ${scheduledError.message}`);
      response = await ghlClient.updateInvoiceSchedule(scheduleId, payload);
    }

    let schedule = extractScheduleFromResponse(response);

    if (!schedule) {
      const detailResponse = await ghlClient.getInvoiceSchedule(scheduleId);
      schedule = extractScheduleFromResponse(detailResponse);
    }

    const normalizedSchedule = normalizeInvoiceSchedule(schedule || payload);
    await persistLocalInvoiceSchedule(normalizedSchedule);

    res.json({
      success: true,
      data: normalizedSchedule
    });
  } catch (error) {
    logger.error(`Error actualizando invoice schedule ${req.params.scheduleId}: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al actualizar plan de pago'
    });
  }
};

export const actionInvoiceSchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const requestedAction = String(req.body?.action || '').trim().toLowerCase();
    const payload = req.body?.payload && typeof req.body.payload === 'object' && !Array.isArray(req.body.payload)
      ? req.body.payload
      : {};
    const actionAliases = {
      activate: 'activate',
      activar: 'activate',
      continue: 'activate',
      continuar: 'activate',
      resume: 'activate',
      reanudar: 'activate',
      schedule: 'activate',
      pause: 'pause',
      pausar: 'pause',
      cancel: 'cancel',
      cancelar: 'cancel',
      delete: 'delete',
      eliminar: 'delete',
      remove: 'delete',
      'auto-payment': 'auto-payment',
      autopayment: 'auto-payment'
    };
    const action = actionAliases[requestedAction];

    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        error: 'scheduleId requerido'
      });
    }

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Acción inválida para plan de pago'
      });
    }

    const ghlClient = await getGHLClient();
    let response;
    let data;

    if (action === 'activate') {
      response = await ghlClient.scheduleInvoiceSchedule(scheduleId, payload);
      data = await normalizePersistedInvoiceScheduleAction(ghlClient, scheduleId, response, 'active', {
        ...payload,
        status: 'active'
      });
    } else if (action === 'pause') {
      const currentSchedule = await getInvoiceScheduleMutationSource(ghlClient, scheduleId);
      const pausePayload = sanitizeInvoiceSchedulePayload({
        ...currentSchedule,
        ...payload,
        status: 'paused',
        scheduleStatus: 'paused',
        state: 'paused'
      });

      response = await ghlClient.updateInvoiceSchedule(scheduleId, pausePayload);
      data = await normalizePersistedInvoiceScheduleAction(ghlClient, scheduleId, response, 'paused', {
        ...payload,
        status: 'paused'
      });
    } else if (action === 'cancel') {
      response = await ghlClient.cancelInvoiceSchedule(scheduleId, payload);
      data = await normalizePersistedInvoiceScheduleAction(ghlClient, scheduleId, response, 'cancelled', {
        ...payload,
        status: 'cancelled'
      });
    } else if (action === 'delete') {
      response = await ghlClient.deleteInvoiceSchedule(scheduleId);
      data = await markLocalInvoiceScheduleStatus(scheduleId, 'deleted', {
        deletedAt: new Date().toISOString()
      });
    } else if (action === 'auto-payment') {
      response = await ghlClient.manageInvoiceScheduleAutoPayment(scheduleId, payload);
      data = await normalizePersistedInvoiceScheduleAction(ghlClient, scheduleId, response, null, payload);
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error(`Error aplicando acción a invoice schedule ${req.params.scheduleId}: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al aplicar acción al plan de pago'
    });
  }
};

/**
 * Envía un link de pago rápido por SMS/WhatsApp (Text2Pay)
 * POST /api/highlevel/text2pay
 * Body: { contactId, amount, currency, message }
 */
export const text2Pay = async (req, res) => {
  try {
    const { contactId, amount, currency, message } = req.body;

    if (!contactId || !amount || !currency) {
      return res.status(400).json({
        success: false,
        error: 'contactId, amount y currency son requeridos'
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      });
    }

    const liveMode = await getGhlInvoiceLiveMode();
    const ghlClient = await getGHLClient();
    const result = await ghlClient.text2Pay({ contactId, amount, currency, message, liveMode });

    logger.success(`Text2Pay enviado a contacto: ${contactId} - Monto: ${amount} ${currency}`);

    res.json({
      success: true,
      message: 'Link de pago enviado por WhatsApp correctamente',
      data: result
    });

  } catch (error) {
    logger.error(`Error en text2Pay: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al enviar link de pago'
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
 * Guarda la configuración de pagos/invoices
 * POST /api/highlevel/invoice-config
 */
export const saveInvoiceConfig = async (req, res) => {
  try {
    const { invoiceTitle, invoiceNumberPrefix, invoiceTermsNotes, invoiceDueDays, transferInfoUrl, cardSetupAmount, ghlInvoiceMode } = req.body;
    const requestedGhlInvoiceMode = ['test', 'live'].includes(ghlInvoiceMode) ? ghlInvoiceMode : null;

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

    const parsedCardSetupAmount = Number(cardSetupAmount ?? 25);
    if (!Number.isFinite(parsedCardSetupAmount) || parsedCardSetupAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto de domiciliación debe ser mayor a 0'
      });
    }

    // Verificar que existe config de HighLevel
    let config;
    try {
      config = await db.get('SELECT id, location_id, ghl_invoice_mode FROM highlevel_config LIMIT 1');
    } catch {
      config = await db.get('SELECT id, location_id FROM highlevel_config LIMIT 1');
    }

    if (!config || !config.location_id) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes configurar tu cuenta de HighLevel'
      });
    }

    const normalizedGhlInvoiceMode = requestedGhlInvoiceMode || normalizeGhlInvoiceMode(config.ghl_invoice_mode);

    // Intentar UPDATE con las columnas de invoice
    const updateSQL = `
      UPDATE highlevel_config
      SET invoice_title = ?,
          invoice_number_prefix = ?,
          invoice_terms_notes = ?,
          invoice_due_days = ?,
          transfer_info_url = ?,
          card_setup_amount = ?,
          ghl_invoice_mode = ?
      WHERE location_id = ?
    `;

    const values = [
      invoiceTitle.trim(),
      invoiceNumberPrefix.trim(),
      formatInvoiceMultilineText(invoiceTermsNotes) || null,
      parseInt(invoiceDueDays),
      transferInfoUrl?.trim() || null,
      Math.round(parsedCardSetupAmount * 100) / 100,
      normalizedGhlInvoiceMode,
      config.location_id
    ];

    try {
      await db.run(updateSQL, values);
    } catch (updateError) {
      // Si falla porque las columnas no existen, agregarlas primero
      if (updateError.message.includes('no such column') || updateError.message.includes('does not exist')) {
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

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN card_setup_amount REAL DEFAULT 25');
          logger.success('✅ Columna card_setup_amount agregada');
        } catch (e) {
          if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
            throw e;
          }
        }

        try {
          await db.run('ALTER TABLE highlevel_config ADD COLUMN ghl_invoice_mode TEXT DEFAULT \'live\'');
          logger.success('✅ Columna ghl_invoice_mode agregada');
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
 * GET /api/highlevel/users?accessToken=xxx&locationId=yyy
 */
export const getLocationUsers = async (req, res) => {
  try {
    logger.info('🔵 [getLocationUsers] Request recibido');
    logger.info('🔵 [getLocationUsers] Query params:', req.query);

    const { accessToken, locationId } = req.query;

    // Si se proporciona accessToken y locationId en query params, usar esos
    let ghlClient;
    let targetLocationId;

    if (accessToken && locationId) {
      logger.info('🔵 [getLocationUsers] Usando accessToken y locationId del query');
      const { default: GHLClient } = await import('../services/ghlClient.js');
      ghlClient = new GHLClient(accessToken, locationId);
      targetLocationId = locationId;
    } else {
      // Fallback: usar config de la DB
      logger.info('🔵 [getLocationUsers] Usando configuración de la DB');
      ghlClient = await getGHLClient();
      const config = await db.get('SELECT * FROM highlevel_config LIMIT 1');

      if (!config || !config.location_id) {
        logger.error('🔴 [getLocationUsers] ❌ No hay configuración de HighLevel');
        return res.status(400).json({
          success: false,
          error: 'No hay configuración de HighLevel activa'
        });
      }
      targetLocationId = config.location_id;
    }

    logger.info(`🔵 [getLocationUsers] Obteniendo usuarios para location: ${targetLocationId}`);
    const users = await ghlClient.getLocationUsers(targetLocationId);
    logger.info(`🟢 [getLocationUsers] ✅ ${users.length} usuarios obtenidos`);

    res.json({
      success: true,
      users: users || []
    });

  } catch (error) {
    logger.error(`🔴 [getLocationUsers] ❌ Error: ${error.message}`);
    logger.error(`🔴 [getLocationUsers] Stack: ${error.stack}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener usuarios del location'
    });
  }
};

/**
 * Obtener usuarios por IDs (para Round Robin teamMembers)
 * POST /api/highlevel/users/by-ids
 * Body: { userIds: ['id1', 'id2', 'id3'], accessToken, locationId }
 */
export const getUsersByIds = async (req, res) => {
  try {
    logger.info('🔵 [getUsersByIds] Request recibido');
    logger.info('🔵 [getUsersByIds] Body:', JSON.stringify(req.body, null, 2));

    const { userIds, accessToken, locationId } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      logger.error('🔴 [getUsersByIds] ❌ userIds inválido o vacío');
      return res.status(400).json({
        success: false,
        error: 'Debes proporcionar un array de userIds'
      });
    }

    logger.info(`🔵 [getUsersByIds] UserIds recibidos: ${JSON.stringify(userIds)}`);
    logger.info(`🔵 [getUsersByIds] AccessToken: ${accessToken ? accessToken.substring(0, 20) + '...' : 'NO PROPORCIONADO'}`);
    logger.info(`🔵 [getUsersByIds] LocationId: ${locationId || 'NO PROPORCIONADO'}`);

    // Si se proporciona accessToken y locationId, usar esos en vez de los de la DB
    let ghlClient;
    if (accessToken && locationId) {
      logger.info('🔵 [getUsersByIds] Usando accessToken y locationId del request');
      const { default: GHLClient } = await import('../services/ghlClient.js');
      ghlClient = new GHLClient(accessToken, locationId);
    } else {
      logger.info('🔵 [getUsersByIds] Usando configuración de la DB');
      ghlClient = await getGHLClient();
    }

    logger.info('🔵 [getUsersByIds] Cliente GHL creado, llamando a getUsersByIds...');
    const users = await ghlClient.getUsersByIds(userIds);
    logger.info(`🟢 [getUsersByIds] ✅ Usuarios obtenidos: ${users.length}`);
    logger.info('🟢 [getUsersByIds] Usuarios:', JSON.stringify(users, null, 2));

    res.json({
      success: true,
      data: users || []
    });

  } catch (error) {
    logger.error(`🔴 [getUsersByIds] ❌ Error: ${error.message}`);
    logger.error(`🔴 [getUsersByIds] Stack: ${error.stack}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener usuarios por IDs'
    });
  }
};

/**
 * Sincroniza un invoice específico desde HighLevel a BD local (upsert seguro).
 * Llamado desde el frontend después de crear/pagar un invoice para que los datos
 * aparezcan inmediatamente en la página de transacciones sin hacer un sync completo.
 *
 * POST /api/highlevel/invoices/:invoiceId/sync
 */
export const syncInvoice = async (req, res) => {
  try {
    const { invoiceId } = req.params;

    if (!invoiceId) {
      return res.status(400).json({ success: false, error: 'invoiceId requerido' });
    }

    const result = await syncSingleInvoice(invoiceId);

    res.json(result);
  } catch (error) {
    logger.error(`Error en syncInvoice(${req.params.invoiceId}): ${error.message}`);
    // Responder error pero con código 200 para que el frontend no trate esto como falla crítica
    res.status(200).json({
      success: false,
      error: error.message || 'No se pudo sincronizar el invoice desde HighLevel'
    });
  }
};
