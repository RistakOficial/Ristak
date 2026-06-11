import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import fetch from 'node-fetch';
import { getAIAgentStatus } from '../services/aiAgentService.js';
import { getGoogleCalendarConfig } from '../services/googleCalendarService.js';

// La verificación del token contra la API de HighLevel es costosa y este
// endpoint se consulta varias veces por carga de página. Se cachea el
// resultado por token/location durante un periodo corto.
const GHL_VERIFY_TTL_MS = 60_000;
let ghlVerifyCache = { key: null, verifiedAt: 0, connected: false, locationData: null };

async function verifyHighLevelConnection(config) {
  const cacheKey = `${config.location_id}:${config.api_token}`;
  const now = Date.now();

  if (ghlVerifyCache.key === cacheKey && now - ghlVerifyCache.verifiedAt < GHL_VERIFY_TTL_MS) {
    return { connected: ghlVerifyCache.connected, locationData: ghlVerifyCache.locationData };
  }

  let connected = false;
  let locationData = null;

  try {
    const response = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(config.location_id), {
      headers: {
        'Authorization': `Bearer ${config.api_token}`,
        'Version': '2021-07-28'
      }
    });

    if (response.ok) {
      const data = await response.json();
      locationData = data.location || data;
      connected = true;

      // Actualizar datos del location si cambiaron
      if (JSON.stringify(locationData) !== config.location_data) {
        await db.run(
          'UPDATE highlevel_config SET location_data = ? WHERE location_id = ?',
          [JSON.stringify(locationData), config.location_id]
        );
      }
    }
  } catch (error) {
    // Si hay error de red, consideramos que no está conectado
    logger.warn('Error verificando conexión con HighLevel:', error.message);
  }

  ghlVerifyCache = { key: cacheKey, verifiedAt: now, connected, locationData };
  return { connected, locationData };
}

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

      const verification = await verifyHighLevelConnection(config);
      highlevelStatus.connected = verification.connected;
      if (verification.locationData) {
        highlevelStatus.locationData = verification.locationData;
      }
    }

    const metaConfig = await db.get(
      'SELECT ad_account_id, access_token, pixel_id, page_id, instagram_account_id FROM meta_config LIMIT 1'
    );

    const metaStatus = {
      configured: Boolean(metaConfig?.ad_account_id && metaConfig?.access_token),
      connected: Boolean(metaConfig?.ad_account_id && metaConfig?.access_token),
      adAccountId: metaConfig?.ad_account_id || null,
      pixelId: metaConfig?.pixel_id || null,
      pageId: metaConfig?.page_id || null,
      instagramAccountId: metaConfig?.instagram_account_id || null
    };

    // WhatsApp: se lee directo de app_config (ligero) para no disparar el
    // status completo, que es costoso. Conectado = habilitado + API key + webhook.
    let whatsappStatus = { configured: false, connected: false };
    try {
      const waRows = await db.all(
        `SELECT config_key, config_value FROM app_config
         WHERE config_key IN ('whatsapp_api_enabled', 'whatsapp_api_key', 'whatsapp_api_webhook_endpoint_id')`
      );
      const wa = {};
      for (const row of waRows || []) wa[row.config_key] = row.config_value;
      const enabled = wa['whatsapp_api_enabled'] !== '0';
      const hasApiKey = Boolean(wa['whatsapp_api_key']);
      const hasWebhook = Boolean(wa['whatsapp_api_webhook_endpoint_id']);
      whatsappStatus = {
        configured: hasApiKey,
        connected: Boolean(enabled && hasApiKey && hasWebhook)
      };
    } catch (error) {
      logger.warn(`Error obteniendo estado de WhatsApp: ${error.message}`);
    }

    // OpenAI (Agente AI)
    let openaiStatus = { configured: false, connected: false };
    try {
      const aiStatus = await getAIAgentStatus({});
      openaiStatus = {
        configured: Boolean(aiStatus?.configured),
        connected: Boolean(aiStatus?.configured),
        credentialStatus: aiStatus?.credentialStatus || 'missing'
      };
    } catch (error) {
      logger.warn(`Error obteniendo estado de OpenAI: ${error.message}`);
    }

    // Google Calendar
    let googleCalendarStatus = { configured: false, connected: false };
    try {
      const calConfig = await getGoogleCalendarConfig();
      googleCalendarStatus = {
        configured: Boolean(calConfig?.connected),
        connected: Boolean(calConfig?.connected)
      };
    } catch (error) {
      logger.warn(`Error obteniendo estado de Google Calendar: ${error.message}`);
    }

    // Respuesta con estructura mejorada
    res.json({
      highlevel: highlevelStatus,
      meta: metaStatus,
      whatsapp: whatsappStatus,
      openai: openaiStatus,
      googleCalendar: googleCalendarStatus
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
      whatsapp: { configured: false, connected: false },
      openai: { configured: false, connected: false },
      googleCalendar: { configured: false, connected: false },
      error: 'Error al obtener estado de integraciones'
    });
  }
};
