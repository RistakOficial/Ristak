import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { updateSingleContactStats } from '../utils/updateContactsStats.js';

/**
 * Procesa webhook de contacto nuevo o actualizado
 */
export const handleContactWebhook = async (req, res) => {
  try {
    const data = req.body;

    // HighLevel puede mandar el ID en diferentes lugares
    const contactId = data.contact_id || data.id || data.contactId;

    logger.info(`📥 Webhook de contacto recibido: ${contactId || 'sin ID'}`);

    if (!contactId) {
      logger.warn('Webhook de contacto sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    // Extraer datos de atribución (pueden venir en diferentes estructuras)
    const attribution = data.attributions?.find(a => a.isFirst)
      || data.contact?.attributionSource
      || data.contact?.lastAttributionSource
      || data.attributionSource
      || {};

    const usePostgres = process.env.DATABASE_URL ? true : false;

    const query = usePostgres
      ? `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source, created_at,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
          phone = EXCLUDED.phone, email = EXCLUDED.email, full_name = EXCLUDED.full_name,
          first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, updated_at = CURRENT_TIMESTAMP`
      : `INSERT OR REPLACE INTO contacts (id, phone, email, full_name, first_name, last_name, source, created_at,
          attribution_url, attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.run(query, [
      contactId,
      data.phone || data.contactPhone,
      data.email,
      data.full_name || data.contactName || `${data.first_name || data.firstName || ''} ${data.last_name || data.lastName || ''}`.trim() || 'Sin nombre',
      data.first_name || data.firstName,
      data.last_name || data.lastName,
      data.source || attribution.sessionSource || 'gohighlevel',
      data.date_created || data.dateCreated || data.createdAt || new Date().toISOString(),
      attribution.pageUrl || attribution.url,
      attribution.utmSessionSource || attribution.sessionSource,
      attribution.medium,
      attribution.utmAdId || attribution.mediumId,
      attribution.adName
    ]);

    logger.info(`✅ Contacto ${contactId} procesado exitosamente`);
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
    const payment = req.body;

    logger.info(`📥 Webhook de pago recibido: ${payment._id || payment.id || 'sin ID'}`);

    const paymentId = payment._id || payment.id;
    const contactId = payment.contactId || payment.contact_id;

    if (!paymentId || !contactId) {
      logger.warn('Webhook de pago sin ID o contactId, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const usePostgres = process.env.DATABASE_URL ? true : false;

    // Verificar si el contacto existe, si no crearlo con datos básicos
    const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
    if (!contactExists && contactId) {
      logger.info(`Contacto ${contactId} no existe, creando con datos básicos...`);

      const contactQuery = usePostgres
        ? `INSERT INTO contacts (id, full_name, source) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`
        : `INSERT OR IGNORE INTO contacts (id, full_name, source) VALUES (?, ?, ?)`;

      await db.run(contactQuery, [
        contactId,
        payment.contactName || 'Contacto sin nombre',
        'payment-webhook'
      ]);
    }

    const query = usePostgres
      ? `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, reference, date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           amount = EXCLUDED.amount,
           status = EXCLUDED.status,
           payment_method = EXCLUDED.payment_method,
           reference = EXCLUDED.reference`
      : `INSERT OR REPLACE INTO payments (id, contact_id, amount, currency, status, payment_method, reference, date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    // Extraer método de pago (puede venir como objeto)
    let paymentMethod = payment.paymentProviderType || payment.payment_method || 'manual'
    if (!paymentMethod && payment.paymentMethod) {
      paymentMethod = typeof payment.paymentMethod === 'object'
        ? (payment.paymentMethod.type || payment.paymentMethod.name || payment.paymentMethod.method || 'manual')
        : payment.paymentMethod
    }

    await db.run(query, [
      paymentId,
      contactId,
      payment.amount, // HighLevel envía el monto directo, NO en centavos
      payment.currency || 'MXN',
      payment.status || 'succeeded',
      paymentMethod,
      `${payment.entitySourceName || ''} - Invoice #${payment.entitySourceMeta?.invoiceNumber || ''}`.trim() || payment.reference || paymentId,
      payment.fulfilledAt || payment.date || payment.createdAt || new Date().toISOString(),
      payment.createdAt || new Date().toISOString()
    ]);

    // Actualizar estadísticas del contacto
    await updateSingleContactStats(contactId);

    logger.info(`✅ Pago ${paymentId} procesado exitosamente para contacto ${contactId}`);
    res.status(200).json({ success: true, message: 'Pago procesado' });

  } catch (error) {
    logger.error(`Error en handlePaymentWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de cita
 */
export const handleAppointmentWebhook = async (req, res) => {
  try {
    const appointment = req.body;

    logger.info(`📥 Webhook de cita recibido: ${appointment.id || 'sin ID'}`);

    if (!appointment.id) {
      logger.warn('Webhook de cita sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const contactId = appointment.contactId || appointment.contact_id;
    const usePostgres = process.env.DATABASE_URL ? true : false;

    // Verificar si el contacto existe, si no crearlo con datos básicos
    if (contactId) {
      const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId]);
      if (!contactExists) {
        logger.info(`Contacto ${contactId} no existe, creando con datos básicos...`);

        const contactQuery = usePostgres
          ? `INSERT INTO contacts (id, full_name, source) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO contacts (id, full_name, source) VALUES (?, ?, ?)`;

        await db.run(contactQuery, [
          contactId,
          appointment.contactName || 'Contacto sin nombre',
          'appointment-webhook'
        ]);
      }
    }

    const query = usePostgres
      ? `INSERT INTO appointments (id, calendar_id, contact_id, location_id, title, status,
          appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, appointment_status = EXCLUDED.appointment_status,
          start_time = EXCLUDED.start_time, date_updated = EXCLUDED.date_updated`
      : `INSERT OR REPLACE INTO appointments (id, calendar_id, contact_id, location_id, title, status,
          appointment_status, assigned_user_id, notes, address, start_time, end_time, date_added, date_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.run(query, [
      appointment.id,
      appointment.calendarId || appointment.calendar_id,
      contactId,
      appointment.locationId || appointment.location_id,
      appointment.title,
      appointment.status,
      appointment.appointmentStatus || appointment.appointment_status,
      appointment.assignedUserId || appointment.assigned_user_id,
      appointment.notes,
      appointment.address,
      appointment.startTime || appointment.start_time,
      appointment.endTime || appointment.end_time,
      appointment.dateAdded || appointment.date_added || new Date().toISOString(),
      appointment.dateUpdated || appointment.date_updated || new Date().toISOString()
    ]);

    // Actualizar appointment_date del contacto con la fecha de la cita más próxima
    if (contactId && (appointment.startTime || appointment.start_time)) {
      const startTime = appointment.startTime || appointment.start_time;
      await db.run(`
        UPDATE contacts
        SET appointment_date = ?
        WHERE id = ?
        AND (appointment_date IS NULL OR appointment_date > ?)
      `, [startTime, contactId, startTime]);
    }

    logger.info(`✅ Cita ${appointment.id} procesada exitosamente`);
    res.status(200).json({ success: true, message: 'Cita procesada' });

  } catch (error) {
    logger.error(`Error en handleAppointmentWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};

/**
 * Procesa webhook de reembolso
 */
export const handleRefundWebhook = async (req, res) => {
  try {
    const refund = req.body;

    logger.info(`📥 Webhook de reembolso recibido: ${refund._id || refund.id || 'sin ID'}`);

    const refundId = refund._id || refund.id;

    if (!refundId) {
      logger.warn('Webhook de reembolso sin ID, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    // Obtener el contactId del pago antes de actualizarlo
    const payment = await db.get('SELECT contact_id FROM payments WHERE id = ?', [refundId]);

    // Actualizar el pago como reembolsado
    await db.run(
      `UPDATE payments SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [refundId]
    );

    // Recalcular estadísticas del contacto si se encontró
    if (payment && payment.contact_id) {
      await updateSingleContactStats(payment.contact_id);
    }

    logger.info(`✅ Reembolso ${refundId} procesado exitosamente`);
    res.status(200).json({ success: true, message: 'Reembolso procesado' });

  } catch (error) {
    logger.error(`Error en handleRefundWebhook: ${error.message}`);
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

    logger.info(`📥 Webhook de atribución WhatsApp recibido para: ${data.phone || 'sin teléfono'}`);

    if (!data.phone) {
      logger.warn('Webhook de atribución sin teléfono, ignorando');
      return res.status(200).json({ success: true, message: 'Webhook recibido' });
    }

    const usePostgres = process.env.DATABASE_URL ? true : false;
    const query = usePostgres
      ? `INSERT INTO whatsapp_attribution (
          contact_id, phone, referral_source_url, referral_source_type, referral_source_id,
          referral_headline, referral_body, referral_image_url, referral_video_url,
          referral_thumbnail_url, referral_ctwa_clid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`
      : `INSERT INTO whatsapp_attribution (
          contact_id, phone, referral_source_url, referral_source_type, referral_source_id,
          referral_headline, referral_body, referral_image_url, referral_video_url,
          referral_thumbnail_url, referral_ctwa_clid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await db.run(query, [
      data.contact_id || data.contactId,
      data.phone,
      data.referral_source_url || data.sourceUrl || data.source_url,
      data.referral_source_type || data.sourceType || data.source_type,
      data.referral_source_id || data.sourceId || data.source_id,
      data.referral_headline || data.headline,
      data.referral_body || data.body,
      data.referral_image_url || data.imageUrl || data.image_url,
      data.referral_video_url || data.videoUrl || data.video_url,
      data.referral_thumbnail_url || data.thumbnailUrl || data.thumbnail_url,
      data.referral_ctwa_clid || data.ctwa_clid || data.ctwaCLID
    ]);

    logger.info(`✅ Atribución WhatsApp procesada para ${data.phone}`);
    res.status(200).json({ success: true, message: 'Atribución procesada' });

  } catch (error) {
    logger.error(`Error en handleWhatsAppAttributionWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};
