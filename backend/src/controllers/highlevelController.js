import fetch from 'node-fetch';
import { db } from '../config/database.js';
import { syncHighLevelData, getSyncProgress } from '../services/highlevelSyncService.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import { getGHLClient } from '../services/ghlClient.js';

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
    const config = await db.get(
      'SELECT location_id, api_token, created_at FROM highlevel_config LIMIT 1'
    );

    if (!config) {
      return res.json({
        configured: false,
        locationId: null,
        hasToken: false,
        apiTokenPreview: null
      });
    }

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
      updatedAt: config.created_at
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

    // Usar GHL Client
    const ghlClient = await getGHLClient();
    const data = await ghlClient.createInvoice(invoiceData);

    res.json({
      success: true,
      invoice: data.invoice || data
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
 * Registra un pago offline en HighLevel
 */
export const recordPayment = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { amount, currency, fulfilledAt, note } = req.body;

    // Usar GHL Client
    const ghlClient = await getGHLClient();
    const data = await ghlClient.recordPayment(invoiceId, {
      amount,
      currency,
      fulfilledAt: fulfilledAt || new Date().toISOString(),
      note: note || 'Pago registrado manualmente'
    });

    res.json({
      success: true,
      message: 'Pago registrado correctamente',
      data: data
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
