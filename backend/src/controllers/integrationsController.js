import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import fetch from 'node-fetch';
import { getAIAgentStatus } from '../services/aiAgentService.js';
import { getGoogleCalendarConfig } from '../services/googleCalendarService.js';
import { getStripePaymentConfig } from '../services/stripePaymentService.js';
import { getMercadoPagoPaymentConfig } from '../services/mercadoPagoPaymentService.js';
import { getConektaPaymentConfig } from '../services/conektaPaymentService.js';
import { getClipPaymentConfig } from '../services/clipPaymentService.js';
import { getRebillPaymentConfig } from '../services/rebillPaymentService.js';
import { getMetaConfig, getMetaSocialConfig } from '../services/metaAdsService.js';
import {
  isMetaDirectWhatsAppConnected,
  isWhatsAppQrConnected
} from '../services/integrationConnectionStateService.js';

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

async function resolveLocalIntegrationStatus(label, fallback, loader) {
  try {
    return await loader();
  } catch (error) {
    logger.warn(`Error obteniendo estado de ${label}: ${error.message}`);
    return fallback;
  }
}

/**
 * Obtiene el estado de las integraciones
 */
export const getStatus = async (req, res) => {
  try {
    const verifyExternal = ['1', 'true', 'yes'].includes(String(req.query.verify || '').trim().toLowerCase());
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
      // El status global sólo expone metadata. El token permanece en backend y
      // jamás viaja al navegador ni queda en snapshots persistentes.
      highlevelStatus.accessToken = null;

      // Parsear los datos del location si existen
      if (config.location_data) {
        try {
          highlevelStatus.locationData = JSON.parse(config.location_data);
        } catch (error) {
          logger.warn('Error parseando location_data:', error.message);
        }
      }

      // Navegar por el CRM no debe esperar a HighLevel. Conexión significa que
      // existe configuración local; la verificación remota queda disponible
      // sólo para una acción explícita de diagnóstico/reconexión.
      highlevelStatus.connected = Boolean(config.location_id && config.api_token);
      if (verifyExternal) {
        const verification = await verifyHighLevelConnection(config);
        highlevelStatus.connected = verification.connected;
        if (verification.locationData) {
          highlevelStatus.locationData = verification.locationData;
        }
      }
    }

    // Todos los proveedores siguientes son lecturas locales independientes.
    // Resolverlos en paralelo evita que cada página pague la suma de nueve
    // consultas/configuraciones secuenciales al montar el shell.
    const [
      [metaConfig, metaSocialConfig],
      whatsappStatus,
      openaiStatus,
      googleCalendarStatus,
      stripeStatus,
      mercadoPagoStatus,
      conektaStatus,
      clipStatus,
      rebillStatus
    ] = await Promise.all([
      Promise.all([
        getMetaConfig().catch(() => null),
        getMetaSocialConfig().catch(() => null)
      ]),
      resolveLocalIntegrationStatus('WhatsApp', { configured: false, connected: false }, async () => {
        const [waRows, metaDirectConnected, qrConnected] = await Promise.all([
          db.all(
            `SELECT config_key, config_value FROM app_config
             WHERE config_key IN ('whatsapp_api_enabled', 'whatsapp_api_ycloud_api_key_encrypted', 'whatsapp_api_key', 'whatsapp_api_webhook_endpoint_id')`
          ),
          isMetaDirectWhatsAppConnected(),
          isWhatsAppQrConnected()
        ]);
        const wa = {};
        for (const row of waRows || []) wa[row.config_key] = row.config_value;
        const enabled = wa['whatsapp_api_enabled'] !== '0';
        const hasApiKey = Boolean(wa['whatsapp_api_ycloud_api_key_encrypted'] || wa['whatsapp_api_key']);
        const hasWebhook = Boolean(wa['whatsapp_api_webhook_endpoint_id']);
        const ycloudConnected = Boolean(enabled && hasApiKey && hasWebhook);
        const connected = ycloudConnected || metaDirectConnected || qrConnected;
        return { configured: connected || hasApiKey, connected };
      }),
      resolveLocalIntegrationStatus('OpenAI', { configured: false, connected: false }, async () => {
        const aiStatus = await getAIAgentStatus({});
        return {
          configured: Boolean(aiStatus?.configured),
          connected: Boolean(aiStatus?.configured),
          credentialStatus: aiStatus?.credentialStatus || 'missing'
        };
      }),
      resolveLocalIntegrationStatus('Google Calendar', { configured: false, connected: false }, async () => {
        const calConfig = await getGoogleCalendarConfig();
        return { configured: Boolean(calConfig?.connected), connected: Boolean(calConfig?.connected) };
      }),
      resolveLocalIntegrationStatus('Stripe', { configured: false, connected: false }, async () => {
        const config = await getStripePaymentConfig();
        return {
          configured: Boolean(config?.configured),
          connected: Boolean(config?.configured),
          connectionType: config?.connectionType || 'manual',
          mode: config?.mode || 'test',
          publishableKey: config?.publishableKey || null,
          accountLabel: config?.accountLabel || null
        };
      }),
      resolveLocalIntegrationStatus('Mercado Pago', { configured: false, connected: false }, async () => {
        const config = await getMercadoPagoPaymentConfig();
        return {
          configured: Boolean(config?.configured),
          connected: Boolean(config?.configured),
          mode: config?.mode || 'test',
          publicKey: config?.publicKey || null,
          accountLabel: config?.accountLabel || null
        };
      }),
      resolveLocalIntegrationStatus('Conekta', { configured: false, connected: false }, async () => {
        const config = await getConektaPaymentConfig();
        return {
          configured: Boolean(config?.configured),
          connected: Boolean(config?.configured),
          mode: config?.mode || 'test',
          publicKey: config?.publicKey || null,
          accountLabel: config?.accountLabel || null
        };
      }),
      resolveLocalIntegrationStatus('CLIP', { configured: false, connected: false }, async () => {
        const config = await getClipPaymentConfig();
        return {
          configured: Boolean(config?.configured),
          connected: Boolean(config?.configured),
          mode: config?.mode || 'test',
          accountLabel: config?.accountLabel || null,
          hasApiKey: Boolean(config?.hasApiKey)
        };
      }),
      resolveLocalIntegrationStatus('Rebill', { configured: false, connected: false }, async () => {
        const config = await getRebillPaymentConfig();
        return {
          configured: Boolean(config?.configured),
          connected: Boolean(config?.configured),
          mode: config?.mode || 'test',
          publicKey: config?.publicKey || null,
          accountLabel: config?.accountLabel || null,
          webhookConfigured: Boolean(config?.webhookConfigured)
        };
      })
    ]);

    const metaStatus = {
      configured: Boolean(
        (metaConfig?.ad_account_id && metaConfig?.access_token) ||
        (metaSocialConfig?.page_id && metaSocialConfig?.access_token)
      ),
      connected: Boolean(
        (metaConfig?.ad_account_id && metaConfig?.access_token) ||
        (metaSocialConfig?.page_id && metaSocialConfig?.access_token)
      ),
      adsConnected: Boolean(metaConfig?.ad_account_id && metaConfig?.access_token),
      socialConnected: Boolean(metaSocialConfig?.page_id && metaSocialConfig?.access_token),
      adAccountId: metaConfig?.ad_account_id || null,
      pixelId: metaConfig?.pixel_id || null,
      pageId: metaSocialConfig?.page_id || null,
      instagramAccountId: metaSocialConfig?.instagram_account_id || null
    };

    // Respuesta con estructura mejorada
    res.json({
      highlevel: highlevelStatus,
      meta: metaStatus,
      whatsapp: whatsappStatus,
      openai: openaiStatus,
      googleCalendar: googleCalendarStatus,
      stripe: stripeStatus,
      mercadopago: mercadoPagoStatus,
      conekta: conektaStatus,
      clip: clipStatus,
      rebill: rebillStatus
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
      mercadopago: { configured: false, connected: false },
      conekta: { configured: false, connected: false },
      clip: { configured: false, connected: false },
      rebill: { configured: false, connected: false },
      error: 'Error al obtener estado de integraciones'
    });
  }
};
