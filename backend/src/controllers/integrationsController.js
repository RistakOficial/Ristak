import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import fetch from 'node-fetch';

/**
 * Obtiene el estado de las integraciones
 */
export const getStatus = async (req, res) => {
  try {
    // Obtener estado de HighLevel
    const config = await db.get(
      'SELECT location_id, api_token, location_data FROM highlevel_config LIMIT 1'
    );

    let highlevelStatus = {
      configured: false,
      connected: false,
      locationId: null,
      locationData: null,
      accessToken: null
    };

    if (config) {
      highlevelStatus.configured = true;
      highlevelStatus.locationId = config.location_id;
      highlevelStatus.accessToken = config.api_token;

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

    const metaConfig = await db.get(
      'SELECT ad_account_id, access_token, pixel_id FROM meta_config LIMIT 1'
    );

    const metaStatus = {
      configured: Boolean(metaConfig?.ad_account_id && metaConfig?.access_token),
      connected: Boolean(metaConfig?.ad_account_id && metaConfig?.access_token),
      adAccountId: metaConfig?.ad_account_id || null,
      pixelId: metaConfig?.pixel_id || null
    };

    // Respuesta con estructura mejorada
    res.json({
      highlevel: highlevelStatus,
      meta: metaStatus
    });

  } catch (error) {
    logger.error(`Error en getStatus: ${error.message}`);
    res.status(500).json({
      highlevel: {
        configured: false,
        connected: false,
        locationId: null,
        locationData: null,
        accessToken: null
      },
      meta: {
        connected: false,
        configured: false
      },
      error: 'Error al obtener estado de integraciones'
    });
  }
};
