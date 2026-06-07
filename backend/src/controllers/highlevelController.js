import crypto from 'crypto';
import fetch from 'node-fetch';
import { db, getAppConfig, setAppConfig } from '../config/database.js';
import { syncHighLevelData, getSyncProgress } from '../services/highlevelSyncService.js';
import { syncSingleInvoice } from '../services/invoicesSyncService.js';
import { logger } from '../utils/logger.js';
import { API_URLS } from '../config/constants.js';
import { getGHLClient } from '../services/ghlClient.js';
import { buildInvoicePaymentUrl } from '../utils/paymentUrl.js';
import { createInstallmentPaymentFlow } from '../services/paymentFlowService.js';
import { sendPaymentNotification } from '../services/pushNotificationsService.js';
import { formatInvoiceMultilineText, formatInvoicePayloadText } from '../utils/invoiceTextFormatter.js';
import { normalizePhoneForStorage } from '../utils/phoneUtils.js';
import { buildLocalMediaUrl, saveWhatsAppAudioDataUrl } from '../services/whatsappApiService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import {
  createLocalPrice,
  createLocalProduct,
  deleteLocalProduct,
  listLocalPrices,
  listLocalProducts,
  prepareInvoiceCatalogItemsForHighLevel,
  syncProductsWithSavedConfig,
  updateLocalProduct
} from '../services/localProductService.js';

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
const GHL_CHAT_CHANNELS = {
  whatsapp_api: {
    key: 'whatsapp_api',
    type: 'WhatsApp',
    label: 'WhatsApp API',
    transport: 'ghl_whatsapp',
    localTable: 'whatsapp'
  },
  sms_qr: {
    key: 'sms_qr',
    type: 'SMS',
    label: 'SMS',
    transport: 'ghl_sms',
    localTable: 'whatsapp'
  },
  messenger: {
    key: 'messenger',
    type: 'FB',
    label: 'Messenger',
    transport: 'ghl_messenger',
    localTable: 'meta',
    platform: 'messenger'
  },
  instagram: {
    key: 'instagram',
    type: 'IG',
    label: 'Instagram',
    transport: 'ghl_instagram',
    localTable: 'meta',
    platform: 'instagram'
  }
};
const GHL_CHAT_CHANNEL_ALIASES = {
  whatsapp: 'whatsapp_api',
  whatsappapi: 'whatsapp_api',
  whatsapp_api: 'whatsapp_api',
  ghl_whatsapp: 'whatsapp_api',
  sms: 'sms_qr',
  qr: 'sms_qr',
  sms_qr: 'sms_qr',
  baileys: 'sms_qr',
  bailey: 'sms_qr',
  whatsapp_qr: 'sms_qr',
  ghl_sms: 'sms_qr',
  fb: 'messenger',
  facebook: 'messenger',
  messenger: 'messenger',
  ghl_messenger: 'messenger',
  ig: 'instagram',
  instagram: 'instagram',
  ghl_instagram: 'instagram'
};
const LOCAL_ONLY_CONTACT_PREFIXES = ['waapi_contact_', 'manual_contact_', 'meta_social_contact_', 'rstk_'];
const GHL_WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GHL_REPLY_WINDOW_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const GHL_LOCAL_WHATSAPP_TRANSPORTS = new Set([
  '',
  'api',
  'qr',
  'whatsapp',
  'whatsapp_api',
  'ghl_whatsapp',
  'baileys',
  'bailey',
  'whatsapp_qr'
]);
const GHL_INBOUND_DIRECTIONS = new Set(['inbound', 'incoming', 'received', 'customer']);

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value = '') {
  return cleanString(value).replace(/\/+$/, '');
}

function getPublicBaseUrl(req) {
  return normalizeBaseUrl(
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    req.body?.baseUrl ||
    `${req.protocol}://${req.get('host')}`
  );
}

function safeJsonStringify(value, fallback = 'null') {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

function hashId(prefix, value) {
  const raw = cleanString(value) || crypto.randomUUID();
  return `${prefix}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

const HIGHLEVEL_ATTACHMENT_MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip'
};

function getHighLevelAttachmentPathname(url = '') {
  const value = cleanString(url);
  if (!value) return '';

  try {
    return new URL(value).pathname || value;
  } catch {
    return value.split('?')[0].split('#')[0];
  }
}

function getHighLevelAttachmentInfo(url = '') {
  const mediaUrl = cleanString(url);
  const pathname = getHighLevelAttachmentPathname(mediaUrl);
  const rawFilename = pathname.split('/').filter(Boolean).pop() || '';
  const mediaFilename = (() => {
    try {
      return decodeURIComponent(rawFilename);
    } catch {
      return rawFilename;
    }
  })();
  const extension = cleanString(mediaFilename.split('.').pop()).toLowerCase();
  const mediaMimeType = HIGHLEVEL_ATTACHMENT_MIME_BY_EXTENSION[extension] || '';
  const messageType = mediaMimeType.startsWith('image/')
    ? 'image'
    : mediaMimeType.startsWith('video/')
      ? 'video'
      : mediaMimeType.startsWith('audio/')
        ? 'audio'
        : mediaMimeType.startsWith('application/') || mediaMimeType.startsWith('text/')
          ? 'document'
          : 'file';

  return {
    mediaUrl,
    mediaMimeType,
    mediaFilename,
    messageType
  };
}

async function prepareHighLevelVoiceAttachment({ audioDataUrl, audioUrl, durationMs, req }) {
  const cleanAudioUrl = cleanString(audioUrl);
  if (cleanAudioUrl) {
    return {
      url: cleanAudioUrl,
      audio: {
        link: cleanAudioUrl,
        url: cleanAudioUrl,
        voice: true,
        ...(durationMs ? { durationMs } : {})
      },
      localMedia: null
    };
  }

  if (!cleanString(audioDataUrl)) return null;

  const savedAudio = await saveWhatsAppAudioDataUrl(audioDataUrl);
  const publicUrl = buildLocalMediaUrl(savedAudio, getPublicBaseUrl(req));

  if (!/^https?:\/\//i.test(publicUrl)) {
    throw new Error('HighLevel necesita un enlace público para mandar la nota de voz.');
  }

  return {
    url: publicUrl,
    audio: {
      link: publicUrl,
      url: publicUrl,
      mimeType: savedAudio.mimeType,
      voice: true,
      ...(durationMs ? { durationMs } : {})
    },
    localMedia: {
      publicUrl,
      publicPath: savedAudio.publicPath,
      mimeType: savedAudio.mimeType,
      filename: savedAudio.filename,
      size: savedAudio.size,
      originalMimeType: savedAudio.originalMimeType
    }
  };
}

function normalizeGhlChatChannel(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
  const compact = normalized.replace(/_/g, '');
  return GHL_CHAT_CHANNELS[GHL_CHAT_CHANNEL_ALIASES[normalized] || GHL_CHAT_CHANNEL_ALIASES[compact] || normalized] || null;
}

function parseTimestampMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === 'number') {
    const time = value > 1e12 ? value : value * 1000;
    return Number.isFinite(time) ? time : null;
  }

  const raw = cleanString(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const time = numeric > 1e12 ? numeric : numeric * 1000;
    return Number.isFinite(time) ? time : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinWhatsAppReplyWindowMs(timestampMs, nowMs = Date.now()) {
  if (!Number.isFinite(timestampMs)) return false;
  const ageMs = nowMs - timestampMs;
  return ageMs <= GHL_WHATSAPP_REPLY_WINDOW_MS && ageMs >= -GHL_REPLY_WINDOW_FUTURE_TOLERANCE_MS;
}

function getHighLevelMessageTimestampMs(message = {}) {
  return parseTimestampMs(firstDefined(
    message.messageTimestamp,
    message.message_timestamp,
    message.dateAdded,
    message.date_added,
    message.createdAt,
    message.created_at,
    message.updatedAt,
    message.updated_at,
    message.timestamp,
    message.date
  ));
}

function highLevelMessageLooksInbound(message = {}) {
  const direction = cleanString(firstDefined(
    message.direction,
    message.messageDirection,
    message.message_direction,
    message.lastMessageDirection,
    message.last_message_direction
  )).toLowerCase().replace(/[\s-]+/g, '_');

  if (direction) {
    return GHL_INBOUND_DIRECTIONS.has(direction) || direction.includes('inbound') || direction.includes('incoming');
  }

  const source = cleanString(firstDefined(
    message.source,
    message.senderType,
    message.sender_type,
    message.authorType,
    message.author_type
  )).toLowerCase();

  return Boolean(source && ['contact', 'customer', 'lead'].some(token => source.includes(token)));
}

function highLevelMessageLooksWhatsApp(message = {}) {
  const channelText = [
    message.channel,
    message.type,
    message.messageType,
    message.message_type,
    message.subType,
    message.sub_type,
    message.source
  ].map(value => cleanString(value).toLowerCase()).filter(Boolean).join(' ');

  return !channelText || channelText.includes('whatsapp') || channelText.includes('type_activity_whatsapp');
}

function extractHighLevelMessageItems(response = {}) {
  const candidates = [
    response.messages,
    response.items,
    response.data,
    response.data?.messages,
    response.data?.items,
    response.data?.data,
    response.result?.messages,
    response.result?.items
  ];

  return candidates.find(Array.isArray) || [];
}

async function findRecentLocalWhatsAppInbound(contactId) {
  if (!cleanString(contactId)) return null;

  const rows = await db.all(
    `SELECT COALESCE(message_timestamp, created_at) AS message_date, transport
     FROM whatsapp_api_messages
     WHERE contact_id = ?
       AND LOWER(COALESCE(direction, '')) = 'inbound'
     ORDER BY COALESCE(message_timestamp, created_at) DESC
     LIMIT 30`,
    [contactId]
  ).catch(error => {
    logger.warn(`[HighLevel Conversations] No se pudo revisar ventana local de WhatsApp: ${error.message}`);
    return [];
  });

  const nowMs = Date.now();
  const recent = rows
    .map(row => ({
      dateMs: parseTimestampMs(row.message_date),
      transport: cleanString(row.transport).toLowerCase()
    }))
    .filter(row => GHL_LOCAL_WHATSAPP_TRANSPORTS.has(row.transport))
    .find(row => isWithinWhatsAppReplyWindowMs(row.dateMs, nowMs));

  return recent
    ? {
        lastInboundAt: new Date(recent.dateMs).toISOString(),
        source: 'local'
      }
    : null;
}

async function findRecentHighLevelWhatsAppInbound({ ghlClient, highLevelContactId }) {
  const cleanContactId = cleanString(highLevelContactId);
  if (!cleanContactId) return null;

  const now = new Date();
  const cutoff = new Date(now.getTime() - GHL_WHATSAPP_REPLY_WINDOW_MS);
  const response = await ghlClient.exportConversationMessages({
    contactId: cleanContactId,
    channel: 'WhatsApp',
    startDate: cutoff.toISOString(),
    endDate: now.toISOString(),
    limit: 100,
    sortBy: 'createdAt',
    sortOrder: 'desc'
  });
  const messages = extractHighLevelMessageItems(response);
  const nowMs = now.getTime();
  const recent = messages
    .map(message => ({
      message,
      dateMs: getHighLevelMessageTimestampMs(message)
    }))
    .filter(item => (
      highLevelMessageLooksInbound(item.message) &&
      highLevelMessageLooksWhatsApp(item.message) &&
      isWithinWhatsAppReplyWindowMs(item.dateMs, nowMs)
    ))
    .sort((left, right) => right.dateMs - left.dateMs)[0];

  return recent
    ? {
        lastInboundAt: new Date(recent.dateMs).toISOString(),
        source: 'highlevel'
      }
    : null;
}

async function resolveHighLevelChatChannelForReply({ requestedChannel, contact, ghlClient, highLevelContactId }) {
  if (requestedChannel.key !== 'whatsapp_api') {
    return {
      channel: requestedChannel,
      requestedChannel,
      replyWindowOpen: null,
      lastInboundAt: null,
      replyWindowSource: null,
      fallbackApplied: false,
      fallbackReason: null
    };
  }

  const localRecent = await findRecentLocalWhatsAppInbound(contact.id);
  if (localRecent) {
    return {
      channel: requestedChannel,
      requestedChannel,
      replyWindowOpen: true,
      lastInboundAt: localRecent.lastInboundAt,
      replyWindowSource: localRecent.source,
      fallbackApplied: false,
      fallbackReason: null
    };
  }

  let remoteRecent = null;
  let remoteError = null;
  try {
    remoteRecent = await findRecentHighLevelWhatsAppInbound({ ghlClient, highLevelContactId });
  } catch (error) {
    remoteError = error;
    logger.warn(`[HighLevel Conversations] No se pudo confirmar ventana WhatsApp en HighLevel para ${highLevelContactId}: ${error.message}`);
  }

  if (remoteRecent) {
    return {
      channel: requestedChannel,
      requestedChannel,
      replyWindowOpen: true,
      lastInboundAt: remoteRecent.lastInboundAt,
      replyWindowSource: remoteRecent.source,
      fallbackApplied: false,
      fallbackReason: null
    };
  }

  return {
    channel: GHL_CHAT_CHANNELS.sms_qr,
    requestedChannel,
    replyWindowOpen: false,
    lastInboundAt: null,
    replyWindowSource: remoteError ? 'highlevel_unavailable' : 'none',
    fallbackApplied: true,
    fallbackReason: remoteError ? 'reply_window_unknown' : 'outside_24h'
  };
}

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
  logger.info('🧹 Limpiando espejos de HighLevel sin borrar datos locales de Ristak...');

  try {
    // Eliminar solo espejos remotos. Los datos creados en Ristak deben sobrevivir
    // para poder sincronizarse con el nuevo location conectado.
    await db.run('DELETE FROM whatsapp_attribution');
    await db.run('DELETE FROM meta_ads');
    await db.run('DELETE FROM payments');
    await db.run('DELETE FROM meta_config');

    try {
      await db.run("DELETE FROM appointments WHERE COALESCE(source, 'ghl') = 'ghl' AND COALESCE(ghl_appointment_id, '') != ''");
      await db.run(`
        UPDATE appointments
        SET location_id = NULL,
            ghl_appointment_id = NULL,
            sync_status = 'pending',
            sync_error = NULL,
            synced_at = NULL,
            date_updated = CURRENT_TIMESTAMP
        WHERE COALESCE(source, 'ristak') != 'ghl'
      `);
    } catch (error) {
      logger.warn(`No se pudo limpiar metadata de citas HighLevel: ${error.message}`);
    }

    try {
      await db.run("DELETE FROM calendars WHERE COALESCE(source, 'ghl') = 'ghl'");
      await db.run(`
        UPDATE calendars
        SET location_id = NULL,
            ghl_calendar_id = NULL,
            sync_status = 'pending',
            sync_error = NULL,
            last_synced_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(source, 'ristak') != 'ghl'
      `);
    } catch (error) {
      logger.warn(`No se pudo limpiar metadata de calendarios HighLevel: ${error.message}`);
    }

    try {
      await db.run("DELETE FROM product_prices WHERE COALESCE(source, 'ghl') = 'ghl'");
      await db.run("DELETE FROM products WHERE COALESCE(source, 'ghl') = 'ghl'");
      await db.run(`
        UPDATE products
        SET location_id = NULL,
            ghl_product_id = NULL,
            sync_status = 'pending',
            sync_error = NULL,
            last_synced_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(source, 'ristak') != 'ghl'
      `);
      await db.run(`
        UPDATE product_prices
        SET location_id = NULL,
            ghl_price_id = NULL,
            ghl_product_id = NULL,
            sync_status = 'pending',
            sync_error = NULL,
            last_synced_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(source, 'ristak') != 'ghl'
      `);
    } catch (error) {
      logger.warn(`No se pudo limpiar metadata de productos HighLevel: ${error.message}`);
    }

    logger.success('✅ Espejos HighLevel limpiados, datos locales preservados');
  } catch (error) {
    logger.error('Error limpiando tablas:', error.message);
    throw error;
  }
}

function normalizeConfigId(value) {
  return String(value || '').trim();
}

function parseAttributionCalendarConfig(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(item => String(item || '').trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function ensureRistakCalendarDefaults() {
  const defaultCalendar = await localCalendarService.ensureDefaultLocalCalendar();
  if (!defaultCalendar?.id) return;

  const configuredDefaultCalendarId = normalizeConfigId(await getAppConfig('default_calendar_id'));
  const configuredAttributionCalendars = parseAttributionCalendarConfig(await getAppConfig('attribution_calendar_ids'));

  const updates = {};

  const resolvedDefaultCalendar = configuredDefaultCalendarId
    ? await localCalendarService.getLocalCalendar(configuredDefaultCalendarId)
    : null;

  if (!configuredDefaultCalendarId || !resolvedDefaultCalendar) {
    updates.default_calendar_id = defaultCalendar.id;
  }

  if (!configuredAttributionCalendars) {
    updates.attribution_calendar_ids = [defaultCalendar.id];
  } else if (configuredAttributionCalendars.length > 0) {
    const resolvedAttributionCalendars = [];

    for (const calendarId of [...new Set(configuredAttributionCalendars)]) {
      const calendar = await localCalendarService.getLocalCalendar(calendarId);
      if (calendar?.id) {
        resolvedAttributionCalendars.push(calendar.id);
      }
    }

    if (resolvedAttributionCalendars.length === 0) {
      updates.attribution_calendar_ids = [defaultCalendar.id];
    } else if (resolvedAttributionCalendars.length !== configuredAttributionCalendars.length) {
      updates.attribution_calendar_ids = resolvedAttributionCalendars;
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    await setAppConfig(key, value);
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
      'SELECT id, location_id FROM highlevel_config LIMIT 1'
    );

    if (existingConfig?.location_id && existingConfig.location_id !== cleanLocationId) {
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
    } else if (existingConfig && !existingConfig.location_id) {
      await db.run(
        'UPDATE highlevel_config SET location_id = ?, api_token = ?, location_data = ? WHERE id = ?',
        [cleanLocationId, cleanToken, locationData ? JSON.stringify(locationData) : null, existingConfig.id]
      );
      logger.info('Configuración parcial de HighLevel completada exitosamente');
    } else {
      // Insertar nueva configuración
      await db.run(
        'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
        [cleanLocationId, cleanToken, locationData ? JSON.stringify(locationData) : null]
      );
      logger.info('Configuración creada exitosamente');
    }

    await ensureRistakCalendarDefaults().catch((error) => {
      logger.warn(`No se pudo inicializar configuración de calendario predeterminado: ${error.message}`);
    });

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[HighLevel Controller] No se pudo reconciliar calendario predeterminado tras guardar HighLevel: ${error.message}`);
    });

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

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[HighLevel Controller] No se pudo reconciliar calendario predeterminado tras desconectar HighLevel: ${error.message}`);
    });

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
 * Lista productos del catalogo local de Ristak.
 * Si HighLevel esta conectado, el catalogo se mantiene sincronizado por el sync general.
 */
export const listProducts = async (req, res) => {
  try {
    const { limit = 100, offset = 0, query = '', sync = 'false' } = req.query;

    if (sync === 'true') {
      await syncProductsWithSavedConfig().catch(error => {
        logger.warn(`No se pudo sincronizar productos antes de listar: ${error.message}`);
      });
    }

    const data = await listLocalProducts({
      limit: Number(limit),
      offset: Number(offset),
      query: String(query || ''),
      includePrices: req.query.includePrices !== 'false'
    });

    res.json({
      success: true,
      products: data.products || [],
      total: data.total || 0,
      source: 'ristak'
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
 * Crea un producto local de Ristak y lo sincroniza a HighLevel si esta conectado.
 */
export const createProduct = async (req, res) => {
  try {
    const product = await createLocalProduct(req.body || {});

    res.status(201).json({
      success: true,
      product,
      message: product.ghlProductId
        ? 'Producto creado y sincronizado con HighLevel'
        : 'Producto creado localmente'
    });
  } catch (error) {
    logger.error(`Error en createProduct: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al crear producto'
    });
  }
};

/**
 * Actualiza un producto local de Ristak y su precio base si viene incluido.
 */
export const updateProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await updateLocalProduct(productId, req.body || {});

    res.json({
      success: true,
      product,
      message: product.ghlProductId
        ? 'Producto actualizado y sincronizado con HighLevel'
        : 'Producto actualizado'
    });
  } catch (error) {
    logger.error(`Error en updateProduct: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al actualizar producto'
    });
  }
};

/**
 * Quita un producto del catálogo visible.
 */
export const deleteProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await deleteLocalProduct(productId);

    res.json({
      success: true,
      ...result,
      message: 'Producto eliminado del catálogo'
    });
  } catch (error) {
    logger.error(`Error en deleteProduct: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al eliminar producto'
    });
  }
};

/**
 * Lista precios locales de un producto
 */
export const listPrices = async (req, res) => {
  try {
    const { productId } = req.params;

    const prices = await listLocalPrices(productId);

    res.json({
      success: true,
      prices
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
 * Crea un precio local para un producto y lo sincroniza si HighLevel esta conectado.
 */
export const createPrice = async (req, res) => {
  try {
    const { productId } = req.params;
    const price = await createLocalPrice(productId, req.body || {});

    res.status(201).json({
      success: true,
      price,
      message: price.ghlPriceId
        ? 'Precio creado y sincronizado con HighLevel'
        : 'Precio creado localmente'
    });
  } catch (error) {
    logger.error(`Error en createPrice: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al crear precio'
    });
  }
};

export const syncProducts = async (req, res) => {
  try {
    const result = await syncProductsWithSavedConfig();
    res.json({
      success: true,
      result
    });
  } catch (error) {
    logger.error(`Error en syncProducts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al sincronizar productos'
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
    const formattedInvoiceData = formatInvoicePayloadText({
      ...(req.body || {}),
      liveMode
    });

    // PASO 1: Crear invoice en HighLevel
    const ghlClient = await getGHLClient();
    const invoiceData = await prepareInvoiceCatalogItemsForHighLevel(formattedInvoiceData, { ghlClient });
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

      const savedPayment = await db.get(
        `SELECT
          p.id,
          p.amount,
          p.currency,
          p.contact_id,
          c.full_name as contact_name
         FROM payments p
         LEFT JOIN contacts c ON c.id = p.contact_id
         WHERE p.ghl_invoice_id = ?
         LIMIT 1`,
        [invoiceId]
      );

      sendPaymentNotification({
        id: savedPayment?.id || invoiceId,
        amount: amount || savedPayment?.amount,
        currency: currency || savedPayment?.currency || 'MXN',
        contactId: savedPayment?.contact_id,
        contactName: savedPayment?.contact_name || 'Cliente'
      }).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${invoiceId}: ${pushError.message}`);
      });
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

function isLocalOnlyContactId(contactId) {
  const id = cleanString(contactId);
  return LOCAL_ONLY_CONTACT_PREFIXES.some(prefix => id.startsWith(prefix));
}

function getContactDisplayName(contact = {}) {
  return firstDefined(
    contact.full_name,
    `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
    contact.email,
    contact.phone,
    'Contacto Ristak'
  );
}

async function getLocalContactForHighLevelMessage(contactId) {
  const id = cleanString(contactId);
  if (!id) return null;

  return db.get(
    `SELECT id, phone, email, full_name, first_name, last_name, source
     FROM contacts
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
}

async function resolveHighLevelContactIdForChat({ contact, ghlClient }) {
  const localContactId = cleanString(contact?.id);
  if (!localContactId) {
    throw new Error('El contacto no existe en Ristak.');
  }

  if (!isLocalOnlyContactId(localContactId)) {
    return localContactId;
  }

  const searches = [];
  if (contact.email) searches.push({ email: contact.email });
  if (contact.phone) searches.push({ phone: contact.phone });

  for (const search of searches) {
    try {
      const result = await ghlClient.searchContacts({ ...search, limit: 5 });
      const match = (result.contacts || []).find(candidate => candidate.id);
      if (match?.id) return match.id;
    } catch (error) {
      logger.warn(`No se pudo buscar contacto en HighLevel para chat (${localContactId}): ${error.message}`);
    }
  }

  if (!contact.email && !contact.phone) {
    throw new Error('Este contacto no tiene teléfono o correo para enlazarlo con HighLevel.');
  }

  const created = await ghlClient.upsertContact({
    name: getContactDisplayName(contact),
    firstName: contact.first_name || '',
    lastName: contact.last_name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    source: 'Ristak Chat'
  });
  const highLevelContact = created.contact || created;
  const highLevelContactId = cleanString(highLevelContact.id || highLevelContact._id);

  if (!highLevelContactId) {
    throw new Error('HighLevel no devolvió el ID del contacto.');
  }

  return highLevelContactId;
}

function getHighLevelMessageId(response = {}, externalId = '') {
  return cleanString(firstDefined(
    response.messageId,
    Array.isArray(response.messageIds) ? response.messageIds[0] : '',
    response.id,
    response.message?.id,
    response.message?.messageId,
    response.data?.id,
    response.data?.messageId,
    response.data?.message?.id,
    response.data?.message?.messageId,
    externalId
  ));
}

function normalizeHighLevelMessageStatus(value = '') {
  const status = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!status) return '';
  if (['read', 'seen', 'opened', 'played'].includes(status)) return 'read';
  if (['delivered', 'delivery_ack'].includes(status)) return 'delivered';
  if (['sent', 'accepted', 'complete', 'completed', 'success', 'succeeded'].includes(status)) return 'sent';
  if (['queued', 'pending', 'processing', 'scheduled'].includes(status)) return 'pending';
  if (['failed', 'error', 'undelivered', 'bounced', 'rejected'].includes(status)) return 'failed';
  return '';
}

function getHighLevelResponseStatus(response = {}) {
  const explicitStatus = normalizeHighLevelMessageStatus(firstDefined(
    response.status,
    response.messageStatus,
    response.message_status,
    response.deliveryStatus,
    response.delivery_status,
    response.message?.status,
    response.message?.messageStatus,
    response.message?.deliveryStatus,
    response.data?.messageStatus,
    response.data?.message_status,
    response.data?.deliveryStatus,
    response.data?.delivery_status,
    response.data?.status
  ));
  if (explicitStatus) return explicitStatus;

  const responseText = cleanString(firstDefined(response.msg, response.message, response.data?.msg)).toLowerCase();
  if (responseText.includes('failed') || responseText.includes('error')) return 'failed';
  if (responseText.includes('queued') || responseText.includes('pending') || responseText.includes('scheduled')) return 'pending';

  return 'pending';
}

async function saveHighLevelWhatsAppMirror({ contact, channel, text, attachments = [], fromNumber, toNumber, externalId, requestBody, response }) {
  const now = new Date().toISOString();
  const remoteMessageId = getHighLevelMessageId(response, externalId);
  const deliveryStatus = getHighLevelResponseStatus(response);
  const contactPhone = normalizePhoneForStorage(toNumber || contact.phone) || cleanString(toNumber || contact.phone);
  const businessPhone = normalizePhoneForStorage(fromNumber) || cleanString(fromNumber);
  const attachmentItems = attachments.map(getHighLevelAttachmentInfo).filter(item => item.mediaUrl);
  const mirrorItems = attachmentItems.length ? attachmentItems : [null];
  const rawPayload = safeJsonStringify({
    provider: 'highlevel',
    channel: channel.key,
    request: requestBody,
    response
  });

  let firstLocalMessageId = '';
  for (const [index, attachment] of mirrorItems.entries()) {
    const localMessageId = hashId(
      'ghl_msg',
      remoteMessageId
        ? `${remoteMessageId}:${index}`
        : `${contact.id}:${channel.key}:${text}:${attachment?.mediaUrl || ''}:${now}:${index}`
    );
    if (!firstLocalMessageId) firstLocalMessageId = localMessageId;

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, wamid, waba_id, business_phone_number_id,
        whatsapp_api_contact_id, contact_id,
        phone, from_phone, to_phone, business_phone, transport, direction, message_type,
        message_text, media_url, media_mime_type, media_filename,
        status, message_timestamp, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, whatsapp_api_messages.contact_id),
        phone = COALESCE(NULLIF(excluded.phone, ''), whatsapp_api_messages.phone),
        from_phone = COALESCE(NULLIF(excluded.from_phone, ''), whatsapp_api_messages.from_phone),
        to_phone = COALESCE(NULLIF(excluded.to_phone, ''), whatsapp_api_messages.to_phone),
        business_phone = COALESCE(NULLIF(excluded.business_phone, ''), whatsapp_api_messages.business_phone),
        transport = COALESCE(NULLIF(excluded.transport, ''), whatsapp_api_messages.transport),
        direction = COALESCE(NULLIF(excluded.direction, ''), whatsapp_api_messages.direction),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), whatsapp_api_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), whatsapp_api_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), whatsapp_api_messages.media_url),
        media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), whatsapp_api_messages.media_mime_type),
        media_filename = COALESCE(NULLIF(excluded.media_filename, ''), whatsapp_api_messages.media_filename),
        status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_messages.status),
        message_timestamp = COALESCE(excluded.message_timestamp, whatsapp_api_messages.message_timestamp),
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, [
      localMessageId,
      remoteMessageId || null,
      null,
      null,
      null,
      null,
      contact.id,
      contactPhone || null,
      businessPhone || null,
      contactPhone || null,
      businessPhone || null,
      channel.transport,
      'outbound',
      attachment?.messageType || 'text',
      index === 0 ? text : '',
      attachment?.mediaUrl || null,
      attachment?.mediaMimeType || null,
      attachment?.mediaFilename || null,
      deliveryStatus,
      now,
      rawPayload
    ]);
  }

  return {
    localMessageId: firstLocalMessageId,
    status: deliveryStatus
  };
}

async function saveHighLevelMetaMirror({ contact, channel, text, attachments = [], externalId, requestBody, response }) {
  const now = new Date().toISOString();
  const platform = channel.platform;
  const remoteMessageId = getHighLevelMessageId(response, externalId);
  const deliveryStatus = getHighLevelResponseStatus(response);
  const attachmentItems = attachments.map(getHighLevelAttachmentInfo).filter(item => item.mediaUrl);
  const mirrorItems = attachmentItems.length ? attachmentItems : [null];
  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [contact.id, platform]
  ).catch(() => null);
  const rawPayload = safeJsonStringify({
    provider: 'highlevel',
    channel: channel.key,
    request: requestBody,
    response
  });

  let firstLocalMessageId = '';
  for (const [index, attachment] of mirrorItems.entries()) {
    const localMessageId = hashId(
      'ghl_meta_msg',
      remoteMessageId
        ? `${remoteMessageId}:${index}`
        : `${contact.id}:${platform}:${text}:${attachment?.mediaUrl || ''}:${now}:${index}`
    );
    if (!firstLocalMessageId) firstLocalMessageId = localMessageId;

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, meta_social_contact_id, contact_id,
        sender_id, recipient_id, page_id, instagram_account_id,
        direction, status, message_type, message_text, media_url, media_mime_type,
        postback_payload, message_timestamp, raw_payload_json, referral_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
        contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
        sender_id = COALESCE(NULLIF(excluded.sender_id, ''), meta_social_messages.sender_id),
        recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_messages.recipient_id),
        page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_messages.page_id),
        instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_messages.instagram_account_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
        status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
        media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), meta_social_messages.media_mime_type),
        message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, [
      localMessageId,
      platform,
      remoteMessageId || null,
      profile?.id || null,
      contact.id,
      profile?.recipient_id || profile?.page_id || profile?.instagram_account_id || null,
      profile?.sender_id || null,
      profile?.page_id || null,
      profile?.instagram_account_id || null,
      'outbound',
      deliveryStatus,
      attachment?.messageType || 'message',
      index === 0 ? text : '',
      attachment?.mediaUrl || null,
      attachment?.mediaMimeType || null,
      null,
      now,
      rawPayload,
      null
    ]);
  }

  return {
    localMessageId: firstLocalMessageId,
    status: deliveryStatus
  };
}

function createHighLevelChatError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function sendHighLevelConversationMessageCore(payload = {}, { req } = {}) {
  const {
    contactId,
    channel,
    message,
    attachments,
    audioDataUrl,
    audioUrl,
    durationMs,
    fromNumber,
    toNumber,
    conversationProviderId,
    externalId
  } = payload || {};
  const channelConfig = normalizeGhlChatChannel(channel);
  const text = cleanString(message);
  const attachmentUrls = Array.isArray(attachments)
    ? attachments.map(item => cleanString(item)).filter(Boolean)
    : [];

  if (!channelConfig) {
    throw createHighLevelChatError('Ese canal no está permitido para enviar desde el chat.');
  }

  const voiceAttachment = await prepareHighLevelVoiceAttachment({
    audioDataUrl,
    audioUrl,
    durationMs,
    req
  });
  const resolvedAttachmentUrls = [
    ...attachmentUrls,
    ...(voiceAttachment?.url ? [voiceAttachment.url] : [])
  ];

  if (!text && resolvedAttachmentUrls.length === 0) {
    throw createHighLevelChatError('Escribe un mensaje o graba una nota de voz antes de enviarlo.');
  }

  if (resolvedAttachmentUrls.some(url => !/^https?:\/\//i.test(url))) {
    throw createHighLevelChatError('HighLevel solo acepta archivos publicados como enlaces.');
  }

  const contact = await getLocalContactForHighLevelMessage(contactId);
  if (!contact) {
    throw createHighLevelChatError('Contacto no encontrado.', 404);
  }

  if ((channelConfig.key === 'whatsapp_api' || channelConfig.key === 'sms_qr') && !cleanString(toNumber || contact.phone)) {
    throw createHighLevelChatError('Este contacto necesita teléfono para enviar por WhatsApp API o SMS/QR.');
  }

  const ghlClient = await getGHLClient();
  const highLevelContactId = await resolveHighLevelContactIdForChat({ contact, ghlClient });
  const cleanFromNumber = normalizePhoneForStorage(fromNumber) || cleanString(fromNumber);
  const cleanToNumber = normalizePhoneForStorage(toNumber || contact.phone) || cleanString(toNumber || contact.phone);
  const channelResolution = await resolveHighLevelChatChannelForReply({
    requestedChannel: channelConfig,
    contact,
    ghlClient,
    highLevelContactId
  });
  const effectiveChannel = channelResolution.channel;
  const requestBody = {
    type: effectiveChannel.type,
    contactId: highLevelContactId,
    status: 'pending',
    ...(text && { message: text }),
    ...(resolvedAttachmentUrls.length > 0 && { attachments: resolvedAttachmentUrls }),
    ...(cleanFromNumber && { fromNumber: cleanFromNumber }),
    ...(cleanToNumber && { toNumber: cleanToNumber }),
    ...(cleanString(conversationProviderId) && { conversationProviderId: cleanString(conversationProviderId) })
  };
  const response = await ghlClient.sendConversationMessage(requestBody);
  const localMirror = effectiveChannel.localTable === 'meta'
    ? await saveHighLevelMetaMirror({
        contact,
        channel: effectiveChannel,
        text,
        attachments: resolvedAttachmentUrls,
        externalId,
        requestBody,
        response
      })
    : await saveHighLevelWhatsAppMirror({
        contact,
        channel: effectiveChannel,
        text,
        attachments: resolvedAttachmentUrls,
        fromNumber: cleanFromNumber,
        toNumber: cleanToNumber,
        externalId,
        requestBody,
        response
      });

  return {
    ...response,
    channel: effectiveChannel.key,
    requestedChannel: channelResolution.requestedChannel.key,
    channelLabel: effectiveChannel.label,
    requestedChannelLabel: channelResolution.requestedChannel.label,
    type: effectiveChannel.type,
    transport: effectiveChannel.transport,
    contactId: contact.id,
    highLevelContactId,
    localMessageId: localMirror.localMessageId,
    status: localMirror.status,
    fallbackApplied: channelResolution.fallbackApplied,
    fallbackReason: channelResolution.fallbackReason,
    replyWindowOpen: channelResolution.replyWindowOpen,
    replyWindowSource: channelResolution.replyWindowSource,
    lastInboundAt: channelResolution.lastInboundAt,
    ...(voiceAttachment?.audio ? { audio: voiceAttachment.audio } : {}),
    ...(voiceAttachment?.localMedia ? { localMedia: voiceAttachment.localMedia } : {})
  };
}

export const sendConversationMessage = async (req, res) => {
  try {
    const data = await sendHighLevelConversationMessageCore(req.body || {}, { req });
    res.json({ success: true, data });
  } catch (error) {
    logger.error(`Error enviando mensaje por HighLevel Conversations: ${error.message}`);
    res.status(error.statusCode || 502).json({
      success: false,
      error: error.message || 'No se pudo enviar el mensaje por HighLevel.'
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
async function searchLocalContactsForCalendar({ query, email, phone, limit = 20 }) {
  const conditions = []
  const params = []
  const cappedLimit = Math.min(Number(limit) || 20, 50)

  if (email) {
    conditions.push('LOWER(email) = LOWER(?)')
    params.push(email)
  }

  if (phone) {
    const normalizedPhone = normalizePhoneForStorage(phone) || phone
    conditions.push('(phone = ? OR REPLACE(REPLACE(REPLACE(REPLACE(phone, ?, ?), ?, ?), ?, ?), ?, ?) LIKE ?)')
    params.push(normalizedPhone, ' ', '', '-', '', '(', '', ')', '', `%${String(normalizedPhone).slice(-10)}%`)
  }

  if (query) {
    const like = `%${String(query).trim().toLowerCase()}%`
    conditions.push(`(
      LOWER(COALESCE(full_name, '')) LIKE ?
      OR LOWER(COALESCE(first_name, '')) LIKE ?
      OR LOWER(COALESCE(last_name, '')) LIKE ?
      OR LOWER(COALESCE(email, '')) LIKE ?
      OR LOWER(COALESCE(phone, '')) LIKE ?
    )`)
    params.push(like, like, like, like, like)
  }

  if (!conditions.length) return []

  const rows = await db.all(`
    SELECT id, full_name, first_name, last_name, email, phone, source
    FROM contacts
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ${cappedLimit}
  `, params)

  return rows.map(contact => {
    const name = contact.full_name ||
      `${contact.first_name || ''} ${contact.last_name || ''}`.trim() ||
      contact.email ||
      contact.phone ||
      'Sin nombre'

    return {
      id: contact.id,
      name,
      firstName: contact.first_name || '',
      lastName: contact.last_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      source: contact.source || 'ristak'
    }
  })
}

export const searchContacts = async (req, res) => {
  try {
    const { query, email, phone, limit = 20 } = req.body;

    let contacts = [];

    try {
      const ghlClient = await getGHLClient();
      const data = await ghlClient.searchContacts({ query, email, phone, limit: Number(limit) });
      contacts = data.contacts || [];
    } catch (error) {
      logger.warn(`Búsqueda GHL no disponible, usando contactos locales: ${error.message}`);
      contacts = await searchLocalContactsForCalendar({ query, email, phone, limit });
    }

    res.json({
      success: true,
      contacts
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

    let contact = null;

    try {
      const ghlClient = await getGHLClient();
      const response = await ghlClient.request(`/contacts/${id}`);
      contact = response.contact || response;
    } catch (error) {
      logger.warn(`Contacto GHL no disponible, usando DB local: ${error.message}`);
      const row = await db.get(
        'SELECT id, full_name, first_name, last_name, email, phone, source FROM contacts WHERE id = ?',
        [id]
      );

      if (row) {
        contact = {
          id: row.id,
          name: row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email || row.phone || 'Sin nombre',
          firstName: row.first_name || '',
          lastName: row.last_name || '',
          email: row.email || '',
          phone: row.phone || '',
          source: row.source || 'ristak'
        };
      }
    }

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      });
    }

    res.json({
      success: true,
      contact
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
