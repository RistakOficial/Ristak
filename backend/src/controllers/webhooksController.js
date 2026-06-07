import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { updateSingleContactStats } from '../utils/updateContactsStats.js';
import { normalizeToUtcIso, getAccountTimezone } from '../utils/dateUtils.js';
import { recordAttendanceAttributionSignal } from '../services/appointmentsMerge.js';
import {
  activatePendingPaymentFlowsForContact,
  markPaymentFlowInvoicePaid
} from '../services/paymentFlowService.js';
import { PAYMENT_MODE_LIVE, getWebhookPaymentMode, normalizePaymentMode } from '../utils/paymentMode.js';
import {
  isSuccessfulPaymentStatus,
  triggerWhatsappAppointmentBookedEvent,
  triggerWhatsappFirstPurchaseEvent
} from '../services/metaWhatsappEventsService.js';
import { resolveHighLevelContactCustomFields } from '../services/highlevelCustomFieldsService.js';
import { hasContactCustomFieldsPayload } from '../utils/contactCustomFields.js';
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert
} from '../services/contactIdentityService.js';
import { normalizePhoneForStorage } from '../utils/phoneUtils.js';
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js';
import {
  META_SIGNATURE_HEADER,
  getMetaWebhookVerifyToken,
  processMetaSocialWebhook
} from '../services/metaSocialMessagingService.js';

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

export const verifyMetaSocialWebhook = async (req, res) => {
  try {
    const mode = String(req.query['hub.mode'] || '').trim();
    const token = String(req.query['hub.verify_token'] || '').trim();
    const challenge = String(req.query['hub.challenge'] || '').trim();
    const expectedToken = await getMetaWebhookVerifyToken();

    if (mode === 'subscribe' && token && token === expectedToken) {
      logger.info('Webhook de Meta verificado correctamente');
      return res.status(200).send(challenge);
    }

    logger.warn('Intento de verificación Meta rechazado');
    return res.sendStatus(403);
  } catch (error) {
    logger.error(`Error verificando webhook Meta: ${error.message}`);
    return res.sendStatus(500);
  }
};

export const handleMetaSocialWebhook = async (req, res) => {
  try {
    await processMetaSocialWebhook({
      payload: req.body || {},
      rawBody: req.rawBody || JSON.stringify(req.body || {}),
      signatureHeader: req.get(META_SIGNATURE_HEADER) || ''
    });

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`Error procesando webhook Meta: ${error.message}`);
    res.status(error.statusCode || 200).json({
      success: error.statusCode ? false : true,
      error: error.statusCode ? error.message : undefined
    });
  }
};

function extractInvoiceWebhookPayload(data) {
  return data.invoice || data.invoiceData || data.data || data.resource || data.object || {};
}

function extractInvoiceWebhookId(data) {
  const invoice = extractInvoiceWebhookPayload(data);
  return firstValue(
    data._id,
    data.id,
    data.invoiceId,
    data.invoice_id,
    data.entityId,
    data.entity_id,
    data.resourceId,
    data.resource_id,
    invoice._id,
    invoice.id,
    invoice.invoiceId,
    invoice.invoice_id
  );
}

function extractPaymentWebhookPayload(data) {
  return data.payment || data.paymentData || data.data?.payment || data.data || data.resource || data.object || {};
}

function maybeJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function extractPaymentPlanWebhookPayload(data) {
  return data.paymentPlan ||
    data.payment_plan ||
    data.invoiceSchedule ||
    data.invoice_schedule ||
    data.data?.paymentPlan ||
    data.data?.payment_plan ||
    data.data?.invoiceSchedule ||
    data.data?.invoice_schedule ||
    data.data ||
    data.resource ||
    data.object ||
    {};
}

function extractArrayValue(...values) {
  return values.find(value => Array.isArray(value)) || [];
}

function booleanToDbValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'test', 'sandbox'].includes(normalized)) return 0;
    if (['true', '1', 'live', 'production'].includes(normalized)) return 1;
  }
  return value ? 1 : 0;
}

function sourceTypeIndicatesInvoice(value) {
  return typeof value === 'string' && value.toLowerCase().includes('invoice');
}

function extractPaymentWebhookInvoiceId(data, payment) {
  const invoice = payment.invoice || data.invoice || data.invoiceData || {};
  const entitySource = maybeJsonObject(payment.entitySource || payment.entity_source || data.entitySource || data.entity_source);
  const sourceMeta = maybeJsonObject(payment.entitySourceMeta || payment.entity_source_meta || data.entitySourceMeta || data.entity_source_meta);
  const chargeSnapshot = maybeJsonObject(payment.chargeSnapshot || payment.charge_snapshot || data.chargeSnapshot || data.charge_snapshot);
  const chargeMetadata = maybeJsonObject(chargeSnapshot.metadata);
  const sourceType = firstValue(
    payment.entitySourceType,
    payment.entity_source_type,
    payment.sourceType,
    payment.source_type,
    data.entitySourceType,
    data.entity_source_type,
    sourceMeta.type,
    sourceMeta.entityType
  );

  return firstValue(
    payment.invoiceId,
    payment.invoice_id,
    payment.invoiceID,
    data.invoiceId,
    data.invoice_id,
    invoice.id,
    invoice._id,
    invoice.invoiceId,
    invoice.invoice_id,
    entitySource.invoiceId,
    entitySource.invoice_id,
    entitySource.id,
    entitySource._id,
    sourceMeta.invoiceId,
    sourceMeta.invoice_id,
    sourceMeta.invoiceID,
    chargeMetadata.invoiceId,
    chargeMetadata.invoice_id,
    sourceTypeIndicatesInvoice(sourceType)
      ? firstValue(
          payment.entitySourceId,
          payment.entity_source_id,
          payment.entityId,
          payment.entity_id,
          data.entitySourceId,
          data.entity_source_id,
          sourceMeta.id,
          sourceMeta._id,
          sourceMeta.entityId,
          sourceMeta.entity_id
        )
      : null
  );
}

async function getConfiguredPaymentModeFallback() {
  try {
    const config = await db.get('SELECT ghl_invoice_mode FROM highlevel_config LIMIT 1');
    return normalizePaymentMode(config?.ghl_invoice_mode, PAYMENT_MODE_LIVE);
  } catch {
    return PAYMENT_MODE_LIVE;
  }
}

function normalizePaymentAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function resolvePaymentPlanId(data, plan) {
  return firstValue(
    data.paymentPlanId,
    data.payment_plan_id,
    data.invoiceScheduleId,
    data.invoice_schedule_id,
    data.scheduleId,
    data.schedule_id,
    data.entityId,
    data.entity_id,
    data.resourceId,
    data.resource_id,
    plan.paymentPlanId,
    plan.payment_plan_id,
    plan.invoiceScheduleId,
    plan.invoice_schedule_id,
    plan.scheduleId,
    plan.schedule_id,
    plan.id,
    plan._id
  );
}

function resolvePaymentPlanScheduleConfig(data, plan) {
  return maybeJsonObject(firstValue(
    plan.schedule,
    plan.scheduleConfig,
    plan.schedule_config,
    data.schedule,
    data.scheduleConfig,
    data.schedule_config
  ));
}

function resolvePaymentPlanContact(data, plan) {
  return maybeJsonObject(firstValue(
    plan.contact,
    plan.contactDetails,
    plan.contact_details,
    plan.customer,
    data.contact,
    data.contactDetails,
    data.contact_details,
    data.customer
  ));
}

function resolvePaymentPlanRecurrenceLabel(plan, scheduleConfig) {
  const recurrence = maybeJsonObject(firstValue(
    plan.recurrence,
    plan.rrule,
    scheduleConfig.recurrence,
    scheduleConfig.rrule
  ));
  const frequency = firstValue(
    plan.recurrenceLabel,
    plan.recurrence_label,
    plan.frequency,
    recurrence.frequency,
    recurrence.freq,
    scheduleConfig.frequency,
    scheduleConfig.freq
  );
  const interval = firstValue(recurrence.interval, scheduleConfig.interval);

  if (!frequency) return null;
  return interval ? `${frequency} cada ${interval}` : String(frequency);
}

function resolvePaymentPlanStatus(data, plan) {
  const explicitStatus = firstValue(
    plan.scheduleStatus,
    plan.schedule_status,
    plan.status,
    plan.state,
    data.scheduleStatus,
    data.schedule_status,
    data.status,
    data.state
  );

  if (explicitStatus) return explicitStatus;

  const eventType = String(firstValue(data.type, data.eventType, data.event, data.eventName) || '').toLowerCase();
  if (eventType.includes('cancel')) return 'cancelled';
  if (eventType.includes('delete')) return 'deleted';
  if (eventType.includes('pause')) return 'paused';
  if (eventType.includes('complete') || eventType.includes('paid')) return 'completed';
  if (eventType.includes('fail')) return 'failed';
  return 'active';
}

function normalizeLookupText(value) {
  return String(value || '').trim();
}

function parseInvoiceNumberFromReference(reference) {
  const cleanReference = normalizeLookupText(reference);
  const match = cleanReference.match(/invoice\s*#?\s*([A-Za-z0-9-]+)/i);
  if (match?.[1]) return match[1];

  const standaloneInvoiceNumber = cleanReference.match(/\b((?:FACTURA|FACT|FAC|INV)[-\s#]*[A-Za-z0-9-]+)\b/i);
  if (standaloneInvoiceNumber?.[1]) return standaloneInvoiceNumber[1].replace(/[\s#]+/g, '-');

  return match?.[1] || null;
}

function getFirstInvoiceItem(invoice = {}) {
  const sources = [invoice.invoiceItems, invoice.items, invoice.lineItems];
  for (const source of sources) {
    if (Array.isArray(source) && source.length > 0) return source[0] || {};
  }
  return {};
}

const RECENT_WEBHOOK_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

function getTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isRecentWebhookCandidate(row, paymentDate) {
  const paymentTimestamp = getTimestamp(paymentDate) || Date.now();
  const rowTimestamps = [row.updated_at, row.created_at, row.date]
    .map(getTimestamp)
    .filter(Boolean);

  return rowTimestamps.some(timestamp => Math.abs(paymentTimestamp - timestamp) <= RECENT_WEBHOOK_MATCH_WINDOW_MS);
}

async function findUniqueRecentInvoicePayment({ paymentId, contactId, amount, paymentDate }) {
  if (!contactId || amount <= 0) return null;

  const candidates = await db.all(
    `SELECT id, contact_id, ghl_invoice_id, payment_mode, status, description, created_at, updated_at, date
     FROM payments
     WHERE contact_id = ?
       AND id != ?
       AND ABS(COALESCE(amount, 0) - ?) < 0.01
       AND (ghl_invoice_id IS NOT NULL OR invoice_number IS NOT NULL)
       AND status IN ('draft', 'sent', 'payment_processing', 'pending', 'paid', 'succeeded', 'completed')
     ORDER BY
       CASE WHEN status IN ('draft', 'sent', 'payment_processing', 'pending') THEN 0 ELSE 1 END,
       updated_at DESC,
       created_at DESC
     LIMIT 5`,
    [contactId, paymentId, amount]
  );

  const recentCandidates = candidates.filter(candidate => isRecentWebhookCandidate(candidate, paymentDate));
  return recentCandidates.length === 1 ? recentCandidates[0] : null;
}

async function findExistingInvoicePayment({ invoiceId, paymentId, contactId, amount, description, invoiceNumber, reference, paymentDate }) {
  if (invoiceId) {
    const existing = await db.get(
      'SELECT id, contact_id, ghl_invoice_id, payment_mode FROM payments WHERE ghl_invoice_id = ? OR id = ? LIMIT 1',
      [invoiceId, invoiceId]
    );

    if (existing) return existing;
  }

  const resolvedInvoiceNumber = invoiceNumber || parseInvoiceNumberFromReference(reference);
  if (contactId && resolvedInvoiceNumber) {
    const existingByNumber = await db.get(
      `SELECT id, contact_id, ghl_invoice_id, payment_mode
       FROM payments
       WHERE contact_id = ?
         AND (
           invoice_number = ?
           OR reference = ?
           OR reference = ?
         )
         AND (ghl_invoice_id IS NOT NULL OR invoice_number IS NOT NULL)
         AND id != ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [contactId, resolvedInvoiceNumber, resolvedInvoiceNumber, `Invoice #${resolvedInvoiceNumber}`, paymentId]
    );

    if (existingByNumber) return existingByNumber;
  }

  const cleanDescription = normalizeLookupText(description);
  if (!contactId || amount <= 0) return null;

  if (cleanDescription) {
    const invoiceBackedMatch = await db.get(
      `SELECT id, contact_id, ghl_invoice_id, payment_mode
       FROM payments
       WHERE contact_id = ?
         AND id != ?
         AND ABS(COALESCE(amount, 0) - ?) < 0.01
         AND LOWER(COALESCE(description, '')) = LOWER(?)
         AND (ghl_invoice_id IS NOT NULL OR invoice_number IS NOT NULL)
       ORDER BY
         CASE WHEN status IN ('draft', 'sent', 'payment_processing', 'pending') THEN 0 ELSE 1 END,
         created_at DESC
      LIMIT 1`,
      [contactId, paymentId, amount, cleanDescription]
    );

    if (invoiceBackedMatch) return invoiceBackedMatch;
  }

  const recentUniqueMatch = await findUniqueRecentInvoicePayment({ paymentId, contactId, amount, paymentDate });
  if (recentUniqueMatch) return recentUniqueMatch;

  if (!cleanDescription.toLowerCase().includes('primer pago')) return null;

  return await db.get(
    `SELECT id, contact_id, ghl_invoice_id, payment_mode
     FROM payments
     WHERE contact_id = ?
       AND id != ?
       AND ABS(COALESCE(amount, 0) - ?) < 0.01
       AND LOWER(COALESCE(description, '')) = LOWER(?)
       AND status IN ('draft', 'sent', 'payment_processing', 'pending', 'paid', 'succeeded', 'completed')
     ORDER BY
       CASE WHEN ghl_invoice_id IS NOT NULL AND ghl_invoice_id != '' THEN 0 ELSE 1 END,
       CASE WHEN COALESCE(payment_mode, 'live') = 'test' THEN 0 ELSE 1 END,
       created_at DESC
     LIMIT 1`,
    [contactId, paymentId, amount, cleanDescription]
  );
}

async function deleteDuplicateWebhookPaymentRows({ paymentId, existingPaymentId, contactId, amount, description }) {
  if (paymentId && paymentId !== existingPaymentId) {
    await db.run(
      `DELETE FROM payments
       WHERE id = ?
         AND (ghl_invoice_id IS NULL OR ghl_invoice_id = '')`,
      [paymentId]
    );
  }

  if (!contactId || amount <= 0 || !normalizeLookupText(description).toLowerCase().includes('primer pago')) {
    return;
  }

  await db.run(
    `DELETE FROM payments
     WHERE id != ?
       AND contact_id = ?
       AND (ghl_invoice_id IS NULL OR ghl_invoice_id = '')
       AND ABS(COALESCE(amount, 0) - ?) < 0.01
       AND LOWER(COALESCE(description, '')) = LOWER(?)
       AND status IN ('paid', 'succeeded', 'completed')`,
    [existingPaymentId, contactId, amount, normalizeLookupText(description)]
  );
}

/**
 * Procesa webhook de contacto nuevo o actualizado
 */
export const handleContactWebhook = async (req, res) => {
  try {
    const data = req.body;

    // HighLevel puede mandar el ID en diferentes lugares
    const contactId = data.contact_id || data.id || data.contactId;
    const email = data.email;
    const phone = normalizePhoneForStorage(data.phone || data.contactPhone) || data.phone || data.contactPhone;

    logger.info(`📥 Webhook de contacto recibido: ${contactId || 'sin ID'}`);

    if (!contactId) {
      logger.warn('Webhook de contacto sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    // Validar que venga al menos email O phone
    if (!email && !phone) {
      logger.warn(`Webhook de contacto ${contactId} sin email ni phone, ignorando`);
      return res.status(200).json({ success: true, message: 'Contacto sin email ni phone' });
    }

    // Extraer datos de atribución (pueden venir en diferentes estructuras)
    // HighLevel puede enviar atribución en attributions[] o attributionSource
    // IMPORTANTE: SIEMPRE usar FIRST attribution, NUNCA lastAttributionSource
    const attribution = data.attributions?.find(a => a.isFirst) || {};

    // Solo usar attributionSource (FIRST attribution)
    const attributionSource = data.contact?.attributionSource
      || data.attributionSource
      || {};

    // Extraer visitor_id del custom field (solo rkvi_id)
    let visitorId = data.rkvi_id || null;

    // Si NO viene visitor_id en el webhook, intentar buscarlo en sessions por email
    // NOTA: sessions solo tiene email, NO tiene phone
    if (!visitorId && email) {
      try {
        const session = await db.get(
          'SELECT visitor_id FROM sessions WHERE email = ? ORDER BY started_at ASC LIMIT 1',
          [email]
        );
        if (session?.visitor_id) {
          visitorId = session.visitor_id;
          logger.info(`🔗 Visitor ID encontrado en sessions por email: ${visitorId} para contacto ${contactId}`);
        }
      } catch (err) {
        logger.warn(`No se pudo buscar visitor_id en sessions: ${err.message}`);
      }
    }

    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const customFieldsResult = await resolveHighLevelContactCustomFields({
      contact: {
        ...data,
        id: contactId
      },
      apiToken: config?.api_token,
      locationId: config?.location_id || data.locationId || data.location_id,
      fetchDetailWhenEmpty: !hasContactCustomFieldsPayload(data)
    });
    const customFieldsJson = customFieldsResult.customFields.length > 0
      ? customFieldsResult.customFieldsJson
      : null;

    const usePostgres = process.env.DATABASE_URL ? true : false;
    const phoneUpsert = await prepareContactPhoneUpsert({ contactId, phone });

    const query = usePostgres
      ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source, created_at,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name, visitor_id, custom_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15::jsonb, '[]'::jsonb))
         ON CONFLICT (id) DO UPDATE SET
          phone = EXCLUDED.phone, email = EXCLUDED.email, full_name = EXCLUDED.full_name,
          first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
          source = EXCLUDED.source,
          attribution_url = EXCLUDED.attribution_url,
          attribution_session_source = EXCLUDED.attribution_session_source,
          attribution_medium = EXCLUDED.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), EXCLUDED.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), EXCLUDED.attribution_ad_name),
          visitor_id = COALESCE(EXCLUDED.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(EXCLUDED.custom_fields, contacts.custom_fields),
          updated_at = CURRENT_TIMESTAMP`
      : `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source, created_at,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name, visitor_id, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'))
         ON CONFLICT (id) DO UPDATE SET
          phone = excluded.phone,
          email = excluded.email,
          full_name = excluded.full_name,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          source = excluded.source,
          attribution_url = excluded.attribution_url,
          attribution_session_source = excluded.attribution_session_source,
          attribution_medium = excluded.attribution_medium,
          attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
          attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
          visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
          custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
          updated_at = CURRENT_TIMESTAMP`;

    await db.run(query, [
      contactId,
      phoneUpsert.phone || null,
      data.email,
      data.full_name || data.contactName || `${data.first_name || data.firstName || ''} ${data.last_name || data.lastName || ''}`.trim() || 'Sin nombre',
      data.first_name || data.firstName,
      data.last_name || data.lastName,
      data.source || attribution.sessionSource || attributionSource.sessionSource || 'gohighlevel',
      data.date_created || data.dateCreated || data.createdAt || new Date().toISOString(),
      attribution.pageUrl || attribution.url || attributionSource.url,
      attribution.utmSessionSource || attribution.sessionSource || attributionSource.utmSessionSource || attributionSource.sessionSource,
      attribution.medium || attributionSource.medium,
      attribution.utmAdId || attributionSource.adId || attributionSource.mediumId,  // Si no hay adId, usar mediumId
      attribution.adName || attributionSource.adName,
      visitorId,
      customFieldsJson
    ]);
    await finalizePreparedPhoneUpsert(phoneUpsert, contactId);

    // Si viene visitor_id, vincular histórico de sesiones
    if (visitorId && contactId) {
      const fullName = data.full_name || data.contactName || `${data.first_name || data.firstName || ''} ${data.last_name || data.lastName || ''}`.trim();

      if (fullName && fullName !== 'Sin nombre') {
        const { linkVisitorToContact, unifyVisitorIds } = await import('../services/trackingService.js');

        // Ejecutar en background sin esperar
        linkVisitorToContact(visitorId, contactId, fullName)
          .then(() => {
            // Después de vincular, unificar todos los visitor_ids al más viejo
            return unifyVisitorIds(contactId);
          })
          .catch(err => {
            logger.error(`Error vinculando/unificando visitor para contact ${contactId}:`, err);
          });
      }
    }

    // Si NO viene visitor_id en el webhook pero el contacto tiene sesiones, unificarlas
    if (!visitorId && contactId) {
      const { unifyVisitorIds } = await import('../services/trackingService.js');

      // Ejecutar en background sin esperar
      unifyVisitorIds(contactId).catch(err => {
        logger.error(`Error unificando visitor_ids para contact ${contactId}:`, err);
      });
    }

    logger.info(`✅ Contacto ${contactId} procesado exitosamente${visitorId ? ` (visitor_id: ${visitorId})` : ''}`);
    res.status(200).json({ success: true, message: 'Contacto procesado' });

  } catch (error) {
    logger.error(`Error en handleContactWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de pago
 */
export const handlePaymentWebhook = async (req, res) => {
  try {
    const data = req.body;
    const payment = extractPaymentWebhookPayload(data);

    // HighLevel manda el ID en payment.transaction_id
    const paymentId = payment.transaction_id || payment.transactionId || payment._id || payment.id || data.id;
    const contactId = firstValue(
      data.contact_id,
      data.contactId,
      payment.contact_id,
      payment.contactId,
      payment.customer?.id,
      payment.contact?.id,
      payment.invoice?.contactId,
      payment.invoice?.contactDetails?.id
    );
    const invoiceId = extractPaymentWebhookInvoiceId(data, payment);

    logger.info(`📥 Webhook de pago recibido: ${paymentId || 'sin ID'}`);

    if (!paymentId || !contactId) {
      logger.warn('Webhook de pago sin ID o contactId, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const usePostgres = process.env.DATABASE_URL ? true : false;

    // Verificar si el contacto existe, si no crearlo con datos básicos
    const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
    if (!contactExists && contactId) {
      logger.info(`Contacto ${contactId} no existe, creando con datos básicos...`);
      const basicPhoneUpsert = await prepareContactPhoneUpsert({
        contactId,
        phone: payment.customer?.phone || data.phone
      });

      const contactQuery = usePostgres
        ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`
        : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

      await db.run(contactQuery, [
        contactId,
        payment.customer?.name || data.full_name || data.contactName || 'Contacto sin nombre',
        basicPhoneUpsert.phone || null,
        'payment-webhook',
        data.date_created || new Date().toISOString()
      ]);
      await finalizePreparedPhoneUpsert(basicPhoneUpsert, contactId);
    }

    // Extraer método de pago
    const paymentMethod = payment.method || payment.gateway || payment.payment_method || payment.paymentMethod || null;

    // Crear referencia con el número de factura
    const sourceMeta = maybeJsonObject(payment.entitySourceMeta || payment.entity_source_meta || data.entitySourceMeta || data.entity_source_meta);
    const chargeSnapshot = maybeJsonObject(payment.chargeSnapshot || payment.charge_snapshot || data.chargeSnapshot || data.charge_snapshot);
    const chargeMetadata = maybeJsonObject(chargeSnapshot.metadata);
    const invoiceNumber = firstValue(
      payment.invoice?.number,
      payment.invoice?.invoiceNumber,
      payment.invoice?.invoice_number,
      payment.invoice?.invoiceNo,
      payment.invoice?.invoice_no,
      payment.invoiceNumber,
      payment.invoice_number,
      payment.invoiceNo,
      payment.invoice_no,
      data.invoiceNumber,
      data.invoice_number,
      data.invoiceNo,
      data.invoice_no,
      sourceMeta.invoiceNumber,
      sourceMeta.invoice_number,
      sourceMeta.invoiceNo,
      sourceMeta.invoice_no,
      chargeMetadata.invoiceNumber,
      chargeMetadata.invoice_number,
      chargeMetadata.invoiceNo,
      chargeMetadata.invoice_no
    ) || '';
    const reference = invoiceNumber
      ? `Invoice #${invoiceNumber}`
      : payment.reference || paymentId;

    const firstInvoiceItem = getFirstInvoiceItem(payment.invoice || {});
    const title = payment.invoice?.title
      || payment.invoice?.name
      || sourceMeta.name
      || payment.title
      || payment.name
      || firstInvoiceItem.name
      || payment.description
      || null;

    const description = firstInvoiceItem.description
      || firstInvoiceItem.name
      || payment.invoice?.description
      || sourceMeta.description
      || payment.description
      || title
      || null;

    const amount = normalizePaymentAmount(payment.total_amount || payment.totalAmount || payment.amount || 0); // HighLevel envía el monto directo, NO en centavos
    const currency = payment.currency_code || payment.currencyCode || payment.currency || 'MXN';
    const status = payment.payment_status || payment.paymentStatus || payment.status || 'succeeded';
    const paymentDate = payment.created_at || payment.fulfilledAt || payment.date || payment.createdAt || new Date().toISOString();
    const createdAt = payment.created_at || payment.createdAt || new Date().toISOString();
    const existingInvoicePayment = await findExistingInvoicePayment({
      invoiceId,
      paymentId,
      contactId,
      amount,
      description,
      invoiceNumber,
      reference,
      paymentDate
    });
    const effectiveInvoiceId = invoiceId || existingInvoicePayment?.ghl_invoice_id || existingInvoicePayment?.id;
    const configuredPaymentMode = await getConfiguredPaymentModeFallback();
    const paymentMode = getWebhookPaymentMode(data, payment, existingInvoicePayment?.payment_mode || configuredPaymentMode);

    if (existingInvoicePayment) {
      await db.run(
        `UPDATE payments
         SET contact_id = COALESCE(contact_id, ?),
             amount = CASE WHEN amount IS NULL OR amount = 0 THEN ? ELSE amount END,
             currency = COALESCE(currency, ?),
             status = ?,
             payment_method = COALESCE(?, payment_method, 'manual'),
             payment_mode = COALESCE(?, payment_mode, 'live'),
             reference = COALESCE(reference, ?),
             title = COALESCE(title, ?),
             description = COALESCE(description, ?),
             date = COALESCE(date, ?),
             ghl_invoice_id = COALESCE(ghl_invoice_id, ?),
             invoice_number = COALESCE(invoice_number, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          contactId,
          amount,
          currency,
          status,
          paymentMethod,
          paymentMode,
          reference,
          title,
          description,
          paymentDate,
          effectiveInvoiceId || null,
          invoiceNumber || null,
          existingInvoicePayment.id
        ]
      );

      await deleteDuplicateWebhookPaymentRows({
        paymentId,
        existingPaymentId: existingInvoicePayment.id,
        contactId,
        amount,
        description
      });
    } else {
      const rowId = effectiveInvoiceId || paymentId;
      const query = usePostgres
        ? `INSERT INTO payments (
             id, contact_id, amount, currency, status, payment_method, payment_mode,
             reference, title, description, date, created_at, ghl_invoice_id, invoice_number
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
             amount = EXCLUDED.amount,
             status = EXCLUDED.status,
             payment_method = EXCLUDED.payment_method,
             payment_mode = EXCLUDED.payment_mode,
             reference = EXCLUDED.reference,
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             ghl_invoice_id = COALESCE(payments.ghl_invoice_id, EXCLUDED.ghl_invoice_id),
             invoice_number = COALESCE(payments.invoice_number, EXCLUDED.invoice_number),
             updated_at = CURRENT_TIMESTAMP`
        : `INSERT INTO payments (
             id, contact_id, amount, currency, status, payment_method, payment_mode,
             reference, title, description, date, created_at, ghl_invoice_id, invoice_number
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             amount = excluded.amount,
             status = excluded.status,
             payment_method = excluded.payment_method,
             payment_mode = excluded.payment_mode,
             reference = excluded.reference,
             title = excluded.title,
             description = excluded.description,
             ghl_invoice_id = COALESCE(ghl_invoice_id, excluded.ghl_invoice_id),
             invoice_number = COALESCE(invoice_number, excluded.invoice_number),
             updated_at = CURRENT_TIMESTAMP`;

      await db.run(query, [
        rowId,
        contactId,
        amount,
        currency,
        status,
        paymentMethod || 'manual',
        paymentMode,
        reference,
        title,
        description,
        paymentDate,
        createdAt,
        effectiveInvoiceId || null,
        invoiceNumber || null
      ]);
    }

    // Actualizar estadísticas del contacto
    await updateSingleContactStats(contactId);

    if (isSuccessfulPaymentStatus(status)) {
      const flow = await markPaymentFlowInvoicePaid(effectiveInvoiceId, {
        contactId,
        amount,
        description,
        invoiceNumber
      });

      if (!flow) {
        const activatedFlows = await activatePendingPaymentFlowsForContact(contactId);
        if (activatedFlows > 0) {
          logger.info(`✅ ${activatedFlows} flujo(s) de parcialidades activado(s) por pago webhook para contacto ${contactId}`);
        }
      }

      await triggerWhatsappFirstPurchaseEvent(contactId, {
        amount,
        currency,
        paymentMode
      });
    }

    logger.info(`✅ Pago ${paymentId} procesado exitosamente para contacto ${contactId}`);
    res.status(200).json({ success: true, message: 'Pago procesado' });

  } catch (error) {
    logger.error(`Error en handlePaymentWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de plan de pagos / invoice schedule.
 */
export const handlePaymentPlanWebhook = async (req, res) => {
  try {
    const data = req.body || {};
    const plan = extractPaymentPlanWebhookPayload(data);
    const planId = resolvePaymentPlanId(data, plan);

    logger.info(`📥 Webhook de plan de pagos recibido: ${planId || 'sin ID'}`);

    if (!planId) {
      logger.warn('Webhook de plan de pagos sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const scheduleConfig = resolvePaymentPlanScheduleConfig(data, plan);
    const contact = resolvePaymentPlanContact(data, plan);
    const items = extractArrayValue(
      plan.items,
      plan.invoiceItems,
      plan.invoice_items,
      plan.lineItems,
      plan.line_items,
      data.items,
      data.invoiceItems,
      data.invoice_items,
      scheduleConfig.items
    );
    const firstItem = items[0] || {};
    const contactId = firstValue(
      data.contact_id,
      data.contactId,
      plan.contact_id,
      plan.contactId,
      contact.id,
      contact._id
    );
    const contactName = firstValue(
      contact.name,
      contact.fullName,
      contact.full_name,
      [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim(),
      [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim(),
      plan.contactName,
      plan.contact_name,
      data.contactName,
      data.contact_name
    );
    const phone = normalizePhoneForStorage(firstValue(contact.phoneNo, contact.phone, plan.phone, data.phone)) ||
      firstValue(contact.phoneNo, contact.phone, plan.phone, data.phone) ||
      null;
    const createdAt = firstValue(plan.createdAt, plan.created_at, data.createdAt, data.created_at);
    const raw = plan && typeof plan === 'object' ? plan : data;

    if (contactId) {
      const existingContact = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
      if (!existingContact) {
        const usePostgres = process.env.DATABASE_URL ? true : false;
        const contactQuery = usePostgres
          ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

        await db.run(contactQuery, [
          contactId,
          contactName || 'Contacto sin nombre',
          phone,
          'payment-plan-webhook',
          createdAt || new Date().toISOString()
        ]);
      }
    }

    await db.run(
      `INSERT INTO payment_plans (
        id, ghl_schedule_id, contact_id, contact_name, email, phone,
        name, title, status, total, currency, description, recurrence_label,
        start_date, next_run_at, end_date, live_mode, item_count,
        schedule_json, raw_json, source, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'webhook', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
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
        planId,
        firstValue(plan.ghl_schedule_id, plan.scheduleId, plan.schedule_id, data.scheduleId, data.schedule_id, planId),
        contactId || null,
        contactName || null,
        firstValue(contact.email, plan.email, data.email) || null,
        phone,
        firstValue(plan.name, plan.title, plan.invoiceName, plan.invoice_name, data.name, data.title, 'Plan de pago'),
        firstValue(plan.title, plan.name, data.title, data.name, 'Plan de pago'),
        resolvePaymentPlanStatus(data, plan),
        normalizePaymentAmount(firstValue(plan.total, plan.amount, plan.grandTotal, plan.grand_total, plan.balance, data.total, data.amount, firstItem.amount)),
        firstValue(plan.currency, scheduleConfig.currency, data.currency, 'MXN'),
        firstValue(firstItem.description, firstItem.name, plan.description, plan.termsNotes, plan.terms_notes, data.description) || null,
        resolvePaymentPlanRecurrenceLabel(plan, scheduleConfig),
        firstValue(plan.startDate, plan.start_date, scheduleConfig.startDate, scheduleConfig.start_date, scheduleConfig.rrule?.startDate, data.startDate, data.start_date) || null,
        firstValue(
          plan.nextRunAt,
          plan.next_run_at,
          plan.nextInvoiceDate,
          plan.next_invoice_date,
          plan.executeAt,
          plan.execute_at,
          scheduleConfig.executeAt,
          scheduleConfig.execute_at,
          scheduleConfig.rrule?.startDate,
          data.nextRunAt,
          data.next_run_at
        ) || null,
        firstValue(plan.endDate, plan.end_date, scheduleConfig.endDate, scheduleConfig.end_date, scheduleConfig.rrule?.endDate, data.endDate, data.end_date) || null,
        booleanToDbValue(firstValue(plan.liveMode, plan.live_mode, data.liveMode, data.live_mode, data.livemode)),
        Number(firstValue(plan.itemCount, plan.item_count, data.itemCount, data.item_count, items.length) || 0),
        JSON.stringify(scheduleConfig || {}),
        JSON.stringify(raw || {}),
        createdAt || null
      ]
    );

    logger.info(`✅ Plan de pagos ${planId} procesado exitosamente`);
    res.status(200).json({ success: true, message: 'Plan de pagos procesado' });
  } catch (error) {
    logger.error(`Error en handlePaymentPlanWebhook: ${error.message}`);
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de cita
 */
export const handleAppointmentWebhook = async (req, res) => {
  try {
    const data = req.body;
    const calendar = data.calendar || {};

    // HighLevel manda el ID de la cita en calendar.appointmentId
    const appointmentId = calendar.appointmentId || data.id || data.appointment_id;
    const appointmentCalendarId = calendar.id || data.calendarId || data.calendar_id;

    logger.info(`📥 Webhook de cita recibido: ${appointmentId || 'sin ID'}`);

    if (!appointmentId) {
      logger.warn('Webhook de cita sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const contactId = data.contact_id || data.contactId;
    const usePostgres = process.env.DATABASE_URL ? true : false;

    // Verificar si el contacto existe, si no crearlo con datos básicos
    if (contactId) {
      const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
      if (!contactExists) {
        logger.info(`Contacto ${contactId} no existe, creando con datos básicos...`);
        const basicPhoneUpsert = await prepareContactPhoneUpsert({
          contactId,
          phone: data.phone
        });

        const contactQuery = usePostgres
          ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

        await db.run(contactQuery, [
          contactId,
          data.full_name || data.contactName || 'Contacto sin nombre',
          basicPhoneUpsert.phone || null,
          'appointment-webhook',
          data.date_created || new Date().toISOString()
        ]);
        await finalizePreparedPhoneUpsert(basicPhoneUpsert, contactId);
      }
    }

    const query = usePostgres
      ? `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
          appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          appointment_status = EXCLUDED.appointment_status,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          notes = COALESCE(EXCLUDED.notes, appointments.notes),
          address = COALESCE(EXCLUDED.address, appointments.address),
          date_added = COALESCE(appointments.date_added, EXCLUDED.date_added),
          date_updated = EXCLUDED.date_updated`
      : `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
          appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          appointment_status = EXCLUDED.appointment_status,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          notes = COALESCE(EXCLUDED.notes, appointments.notes),
          address = COALESCE(EXCLUDED.address, appointments.address),
          date_added = COALESCE(appointments.date_added, EXCLUDED.date_added),
          date_updated = EXCLUDED.date_updated`;

    // Normalizar instantes a UTC real (GHL manda ISO con offset; lo convertimos
    // para que el instante quede correcto sin importar el tipo de columna).
    const accountZone = await getAccountTimezone();
    const startTime = normalizeToUtcIso(calendar.startTime || data.startTime || data.start_time, accountZone);
    const endTime = normalizeToUtcIso(calendar.endTime || data.endTime || data.end_time, accountZone);
    const dateAdded = normalizeToUtcIso(calendar.date_created || data.dateAdded || data.date_added || new Date().toISOString(), accountZone);
    const dateUpdated = normalizeToUtcIso(calendar.last_updated || data.dateUpdated || data.date_updated || new Date().toISOString(), accountZone);

    await db.run(query, [
      appointmentId,
      appointmentCalendarId,
      contactId,
      data.location?.id || data.locationId || data.location_id,
      calendar.title || data.title || calendar.calendarName,
      calendar.status || data.status,
      calendar.appoinmentStatus || calendar.appointmentStatus || data.appointment_status,
      calendar.created_by_user_id || data.assignedUserId || data.assigned_user_id,
      calendar.notes || data.notes,
      calendar.address || data.address || data.location?.fullAddress,
      startTime,
      endTime,
      dateAdded,
      dateUpdated
    ]);

    // Actualizar appointment_date del contacto con la fecha de la cita más próxima
    if (contactId && startTime) {
      await db.run(`
        UPDATE contacts
        SET appointment_date = ?
        WHERE id = ?
        AND (appointment_date IS NULL OR appointment_date > ?)
      `, [startTime, contactId, startTime]);
    }

    const appointmentStatus = calendar.appoinmentStatus || calendar.appointmentStatus || data.appointment_status || calendar.status || data.status;
    const appointmentStatusNormalized = String(appointmentStatus || '').toLowerCase();
    const isCancelledAppointment = appointmentStatusNormalized.includes('cancel') ||
      appointmentStatusNormalized.includes('no-show') ||
      appointmentStatusNormalized.includes('noshow') ||
      appointmentStatusNormalized.includes('deleted');

    if (contactId && !isCancelledAppointment) {
      await triggerWhatsappAppointmentBookedEvent(contactId, { calendarId: appointmentCalendarId });
    }

    logger.info(`✅ Cita ${appointmentId} procesada exitosamente para contacto ${contactId}`);
    res.status(200).json({ success: true, message: 'Cita procesada' });

  } catch (error) {
    logger.error(`Error en handleAppointmentWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa una señal explícita de HighLevel cuando el prospecto asistió a la cita
 */
export const handleAppointmentShowedWebhook = async (req, res) => {
  try {
    const data = req.body;
    const calendar = data.calendar || {};
    const appointment = data.appointment || {};

    const appointmentId = calendar.appointmentId
      || appointment.appointmentId
      || data.appointmentId
      || data.appointment_id
      || data.eventId
      || data.event_id
      || data.id;

    const contactId = data.contact_id
      || data.contactId
      || data.contact?.id
      || appointment.contactId
      || appointment.contact_id;

    logger.info(`📥 Webhook de cita asistida recibido: ${appointmentId || 'sin ID'}${contactId ? ` (contacto ${contactId})` : ''}`);

    if (!appointmentId && !contactId) {
      logger.warn('Webhook de cita asistida sin appointmentId ni contactId, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const usePostgres = process.env.DATABASE_URL ? true : false;

    if (contactId) {
      const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
      if (!contactExists) {
        const basicPhoneUpsert = await prepareContactPhoneUpsert({
          contactId,
          phone: data.phone || data.contactPhone || data.contact?.phone
        });
        const contactQuery = usePostgres
          ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

        await db.run(contactQuery, [
          contactId,
          data.full_name || data.contactName || data.contact?.name || 'Contacto sin nombre',
          basicPhoneUpsert.phone || null,
          'appointment-showed-webhook',
          data.date_created || data.dateCreated || new Date().toISOString()
        ]);
        await finalizePreparedPhoneUpsert(basicPhoneUpsert, contactId);
      }
    }

    const startTime = calendar.startTime || appointment.startTime || data.startTime || data.start_time;
    const endTime = calendar.endTime || appointment.endTime || data.endTime || data.end_time;
    const dateUpdated = calendar.last_updated || appointment.last_updated || data.dateUpdated || data.date_updated || new Date().toISOString();
    let updatedAppointmentId = appointmentId;

    if (appointmentId) {
      const query = usePostgres
        ? `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
            appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
           VALUES ($1, $2, $3, $4, $5, $6, 'showed', $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
            calendar_id = COALESCE(EXCLUDED.calendar_id, appointments.calendar_id),
            contact_id = COALESCE(EXCLUDED.contact_id, appointments.contact_id),
            location_id = COALESCE(EXCLUDED.location_id, appointments.location_id),
            title = COALESCE(EXCLUDED.title, appointments.title),
            status = COALESCE(EXCLUDED.status, appointments.status),
            appointment_status = 'showed',
            assigned_user_id = COALESCE(EXCLUDED.assigned_user_id, appointments.assigned_user_id),
            notes = COALESCE(EXCLUDED.notes, appointments.notes),
            address = COALESCE(EXCLUDED.address, appointments.address),
            start_time = COALESCE(EXCLUDED.start_time, appointments.start_time),
            end_time = COALESCE(EXCLUDED.end_time, appointments.end_time),
            date_added = COALESCE(appointments.date_added, EXCLUDED.date_added),
            date_updated = EXCLUDED.date_updated`
        : `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
            appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
           VALUES (?, ?, ?, ?, ?, ?, 'showed', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
            calendar_id = COALESCE(EXCLUDED.calendar_id, appointments.calendar_id),
            contact_id = COALESCE(EXCLUDED.contact_id, appointments.contact_id),
            location_id = COALESCE(EXCLUDED.location_id, appointments.location_id),
            title = COALESCE(EXCLUDED.title, appointments.title),
            status = COALESCE(EXCLUDED.status, appointments.status),
            appointment_status = 'showed',
            assigned_user_id = COALESCE(EXCLUDED.assigned_user_id, appointments.assigned_user_id),
            notes = COALESCE(EXCLUDED.notes, appointments.notes),
            address = COALESCE(EXCLUDED.address, appointments.address),
            start_time = COALESCE(EXCLUDED.start_time, appointments.start_time),
            end_time = COALESCE(EXCLUDED.end_time, appointments.end_time),
            date_added = COALESCE(appointments.date_added, EXCLUDED.date_added),
            date_updated = EXCLUDED.date_updated`;

      await db.run(query, [
        appointmentId,
        calendar.id || appointment.calendarId || data.calendarId || data.calendar_id,
        contactId,
        data.location?.id || data.locationId || data.location_id,
        calendar.title || appointment.title || data.title || calendar.calendarName || 'Cita',
        calendar.status || appointment.status || data.status || null,
        calendar.created_by_user_id || appointment.assignedUserId || data.assignedUserId || data.assigned_user_id,
        calendar.notes || appointment.notes || data.notes,
        calendar.address || appointment.address || data.address || data.location?.fullAddress,
        startTime,
        endTime,
        calendar.date_created || appointment.dateAdded || data.dateAdded || data.date_added || new Date().toISOString(),
        dateUpdated
      ]);
    } else if (contactId) {
      const existingAppointment = await db.get(
        `SELECT id FROM appointments
         WHERE contact_id = ?
         ORDER BY
          CASE WHEN start_time IS NULL THEN 1 ELSE 0 END,
          start_time DESC,
          date_added DESC
         LIMIT 1`,
        [contactId]
      );

      if (!existingAppointment) {
        logger.warn(`Webhook showed sin appointmentId y sin cita existente para contacto ${contactId}`);
        return res.status(200).json({ success: true, message: 'Cita asistida recibida sin cita local' });
      }

      updatedAppointmentId = existingAppointment.id;
      await db.run(
        `UPDATE appointments
         SET appointment_status = 'showed',
             status = COALESCE(status, 'showed'),
             date_updated = ?
         WHERE id = ?`,
        [dateUpdated, updatedAppointmentId]
      );
    }

    if (contactId && startTime) {
      await db.run(`
        UPDATE contacts
        SET appointment_date = COALESCE(appointment_date, ?)
        WHERE id = ?
      `, [startTime, contactId]);
    }

    let attendanceContactId = contactId;
    if (!attendanceContactId && updatedAppointmentId) {
      const appointmentRow = await db.get(
        'SELECT contact_id FROM appointments WHERE id = ?',
        [updatedAppointmentId]
      );
      attendanceContactId = appointmentRow?.contact_id;
    }

    if (attendanceContactId) {
      await recordAttendanceAttributionSignal({
        contactId: attendanceContactId,
        appointmentId: updatedAppointmentId,
        source: 'webhook_showed'
      });
    }

    logger.info(`✅ Cita marcada como asistida: ${updatedAppointmentId || 'sin ID'}${contactId ? ` para contacto ${contactId}` : ''}`);
    res.status(200).json({
      success: true,
      message: 'Cita marcada como asistida',
      appointment_id: updatedAppointmentId,
      contact_id: contactId
    });

  } catch (error) {
    logger.error(`Error en handleAppointmentShowedWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de reembolso
 */
export const handleRefundWebhook = async (req, res) => {
  try {
    const data = req.body;

    // HighLevel manda el refund_id en customData.refund_id
    const refundId = data.customData?.refund_id || data._id || data.id || data.refund_id;

    logger.info(`📥 Webhook de reembolso recibido: ${refundId || 'sin ID'}`);

    if (!refundId) {
      logger.warn('Webhook de reembolso sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    // Obtener el contactId del pago antes de actualizarlo
    const payment = await db.get('SELECT contact_id FROM payments WHERE id = ?', [refundId]);

    if (!payment) {
      logger.warn(`Pago ${refundId} no encontrado para reembolso`);
      return res.status(200).json({ success: true, message: 'Pago no encontrado' });
    }

    // Actualizar el pago como reembolsado
    await db.run(
      `UPDATE payments SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [refundId]
    );

    // Recalcular estadísticas del contacto
    if (payment.contact_id) {
      await updateSingleContactStats(payment.contact_id);
      logger.info(`✅ Reembolso ${refundId} procesado exitosamente para contacto ${payment.contact_id}`);
    } else {
      logger.info(`✅ Reembolso ${refundId} procesado exitosamente`);
    }

    res.status(200).json({ success: true, message: 'Reembolso procesado' });

  } catch (error) {
    logger.error(`Error en handleRefundWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhooks de invoices (InvoiceSent, InvoicePaid, InvoiceVoided, InvoiceRefunded)
 */
export const handleInvoiceWebhook = async (req, res) => {
  try {
    const data = req.body;
    const invoicePayload = extractInvoiceWebhookPayload(data);
    const eventType = firstValue(data.type, data.eventType, data.event, data.eventName);

    logger.info(`📥 Webhook de invoice recibido: ${eventType || 'sin tipo'}`);

    // Obtener invoice ID
    const invoiceId = extractInvoiceWebhookId(data);

    if (!invoiceId) {
      logger.warn(`Webhook de invoice sin ID, ignorando: ${JSON.stringify(data).slice(0, 500)}`);
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    // Mapear el tipo de evento al estado
    let newStatus = null;
    let updateFields = {};

    switch (eventType) {
      case 'InvoiceSent':
      case 'invoice.sent':
        newStatus = 'sent';
        updateFields.sent_at = new Date().toISOString();
        logger.info(`Invoice ${invoiceId} fue enviado`);
        break;

      case 'InvoicePaid':
      case 'invoice.paid':
      case 'InvoiceFulfilled':
        newStatus = 'paid';
        updateFields.payment_method = firstValue(
          data.paymentMode,
          data.payment_mode,
          invoicePayload.paymentMode,
          invoicePayload.payment_mode,
          invoicePayload.paymentMethod,
          invoicePayload.payment_method,
          'online'
        );
        logger.info(`Invoice ${invoiceId} fue pagado`);
        break;

      case 'InvoiceVoided':
      case 'invoice.voided':
        newStatus = 'void';
        logger.info(`Invoice ${invoiceId} fue anulado`);
        break;

      case 'InvoiceRefunded':
      case 'invoice.refunded':
        newStatus = 'refunded';
        logger.info(`Invoice ${invoiceId} fue reembolsado`);
        break;

      case 'InvoiceDeleted':
      case 'invoice.deleted': {
        // Eliminar de BD local y recalcular estadísticas del contacto para que
        // no quede como cliente con purchases_count/total_paid obsoletos
        const deletedPayment = await db.get(
          'SELECT contact_id FROM payments WHERE ghl_invoice_id = ?',
          [invoiceId]
        );
        await db.run('DELETE FROM payments WHERE ghl_invoice_id = ?', [invoiceId]);
        if (deletedPayment?.contact_id) {
          await updateSingleContactStats(deletedPayment.contact_id);
          logger.success(`Estadísticas recalculadas tras eliminar invoice para contacto: ${deletedPayment.contact_id}`);
        }
        logger.info(`Invoice ${invoiceId} fue eliminado`);
        return res.status(200).json({ success: true, message: 'Invoice eliminado' });
      }

      default:
        logger.warn(`Tipo de evento de invoice no manejado: ${eventType}`);
        return res.status(200).json({ success: true, message: 'Evento no manejado' });
    }

    if (newStatus) {
      // Construir query de actualización
      const setFields = [`status = ?`];
      const values = [newStatus];
      const paymentModeSignal = firstValue(
        data.liveMode,
        data.live_mode,
        data.livemode,
        data.testMode,
        data.test_mode,
        invoicePayload.liveMode,
        invoicePayload.live_mode,
        invoicePayload.livemode,
        invoicePayload.testMode,
        invoicePayload.test_mode,
        invoicePayload.environment
      );

      if (updateFields.sent_at) {
        setFields.push('sent_at = ?');
        values.push(updateFields.sent_at);
      }

      if (updateFields.payment_method) {
        setFields.push('payment_method = ?');
        values.push(updateFields.payment_method);
      }

      if (paymentModeSignal !== undefined) {
        setFields.push('payment_mode = ?');
        values.push(getWebhookPaymentMode(data, { invoice: invoicePayload }, await getConfiguredPaymentModeFallback()));
      }

      values.push(invoiceId);

      await db.run(
        `UPDATE payments SET ${setFields.join(', ')} WHERE ghl_invoice_id = ?`,
        values
      );

      logger.success(`Estado actualizado a '${newStatus}' para invoice: ${invoiceId}`);

      // Si fue pagado, actualizar estadísticas del contacto
      if (newStatus === 'paid') {
        const payment = await db.get(
          'SELECT contact_id, amount, currency, status, payment_mode FROM payments WHERE ghl_invoice_id = ?',
          [invoiceId]
        );

        if (payment && payment.contact_id) {
          await updateSingleContactStats(payment.contact_id);
          logger.success(`Estadísticas actualizadas para contacto: ${payment.contact_id}`);

          if (isSuccessfulPaymentStatus(payment.status || newStatus)) {
            await triggerWhatsappFirstPurchaseEvent(payment.contact_id, {
              amount: payment.amount,
              currency: payment.currency,
              paymentMode: payment.payment_mode
            });
          }
        }

        await markPaymentFlowInvoicePaid(invoiceId);
      }

      // Si fue reembolsado o anulado, recalcular estadísticas para que el pago
      // deje de contar y el contacto no quede marcado como cliente
      if (newStatus === 'refunded' || newStatus === 'void') {
        const payment = await db.get(
          'SELECT contact_id FROM payments WHERE ghl_invoice_id = ?',
          [invoiceId]
        );

        if (payment && payment.contact_id) {
          await updateSingleContactStats(payment.contact_id);
          logger.success(`Estadísticas recalculadas tras ${newStatus === 'void' ? 'anulación' : 'reembolso'} para contacto: ${payment.contact_id}`);
        }
      }
    }

    res.status(200).json({ success: true, message: 'Invoice webhook procesado' });

  } catch (error) {
    logger.error(`Error en handleInvoiceWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de atribución de WhatsApp
 */
export const handleWhatsAppAttributionWebhook = async (req, res) => {
  try {
    const data = req.body;
    const customData = data.customData || {};

    const phone = normalizePhoneForStorage(data.phone || data.contactPhone) || data.phone || data.contactPhone;
    const contactId = data.contact_id || data.contactId;

    logger.info(`📥 Webhook de atribución WhatsApp recibido para: ${phone || 'sin teléfono'}`);

    if (!phone) {
      logger.warn('Webhook de atribución sin teléfono, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }
    const matchedContact = contactId ? null : await findContactByPhoneCandidates(phone);
    const resolvedContactId = contactId || matchedContact?.id || null;

    const messageContent = customData.message_content || customData.messageContent || data.message_content || data.messageContent || data.message || null;
    const detectedAttribution = detectWhatsAppAttributionFields(data, [messageContent]);

    // Extraer datos de atribución de Click-to-WhatsApp. En WhatsApp, source_id es el ad_id real.
    const referralSourceId = detectedAttribution.sourceId || customData.source_id || data.referral_source_id || data.sourceId || data.source_id || null;
    const referralCtwaClid = detectedAttribution.ctwaClid || customData.ctwa_clid || data.referral_ctwa_clid || data.ctwa_clid || data.ctwaCLID || null;
    const adIdThruMessage = customData.ad_id || customData.adId || data.ad_id || data.adId || null;
    const referralHeadline = customData.headline || data.referral_headline || data.headline || detectedAttribution.headline || null;

    const usePostgres = process.env.DATABASE_URL ? true : false;
    const query = usePostgres
      ? `INSERT INTO whatsapp_attribution (
          contact_id, phone, referral_source_url, referral_source_type, referral_source_id,
          referral_headline, referral_body, referral_image_url, referral_video_url,
          referral_thumbnail_url, referral_ctwa_clid, message_content, ad_id_thru_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`
      : `INSERT INTO whatsapp_attribution (
          contact_id, phone, referral_source_url, referral_source_type, referral_source_id,
          referral_headline, referral_body, referral_image_url, referral_video_url,
          referral_thumbnail_url, referral_ctwa_clid, message_content, ad_id_thru_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.run(query, [
      resolvedContactId,
      phone,
      customData.source_url || data.referral_source_url || data.sourceUrl || data.source_url || detectedAttribution.sourceUrl,
      customData.source_type || data.referral_source_type || data.sourceType || data.source_type || detectedAttribution.sourceType,
      referralSourceId,
      referralHeadline,
      customData.body || data.referral_body || data.body || detectedAttribution.body,
      customData.image_url || data.referral_image_url || data.imageUrl || data.image_url,
      customData.video_url || data.referral_video_url || data.videoUrl || data.video_url,
      customData.thumbnail_url || data.referral_thumbnail_url || data.thumbnailUrl || data.thumbnail_url,
      referralCtwaClid,
      messageContent,
      adIdThruMessage
    ]);

    // Usar referral_source_id como ad_id si viene disponible
    let finalAdId = referralSourceId || adIdThruMessage || null;

    if (resolvedContactId) {
      const contactUpdates = [];
      const contactParams = [];

      if (finalAdId) {
        contactUpdates.push('attribution_ad_id = ?');
        contactParams.push(finalAdId);
      }

      if (referralCtwaClid) {
        contactUpdates.push('attribution_ctwa_clid = ?');
        contactParams.push(referralCtwaClid);
      }

      if (referralHeadline) {
        contactUpdates.push('attribution_ad_name = ?');
        contactParams.push(referralHeadline);
      }

      if (contactUpdates.length > 0) {
        contactUpdates.push('updated_at = CURRENT_TIMESTAMP');
        contactParams.push(resolvedContactId);

        await db.run(
          `UPDATE contacts SET ${contactUpdates.join(', ')} WHERE id = ?`,
          contactParams
        );
      }
    }

    if (finalAdId && resolvedContactId) {
      logger.info(`✅ Ad ID guardado en contacts para ${resolvedContactId}: ${finalAdId}`);
    }

    if (referralCtwaClid && resolvedContactId) {
      logger.info(`✅ CTWA CLID guardado en contacts para ${resolvedContactId}`);
    }

    logger.info(`✅ Atribución WhatsApp procesada para ${phone} (contacto ${resolvedContactId || 'sin_contacto'}) - Ad ID final: ${finalAdId || 'ninguno'}`);
    res.status(200).json({
      success: true,
      message: 'Atribución procesada',
      final_ad_id: finalAdId
    });

  } catch (error) {
    logger.error(`Error en handleWhatsAppAttributionWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};
