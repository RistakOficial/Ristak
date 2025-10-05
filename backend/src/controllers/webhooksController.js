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
    const data = req.body;
    const payment = data.payment || {};

    // HighLevel manda el ID en payment.transaction_id
    const paymentId = payment.transaction_id || payment._id || payment.id || data.id;
    const contactId = data.contact_id || data.contactId || payment.customer?.id;

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

      const contactQuery = usePostgres
        ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`
        : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

      await db.run(contactQuery, [
        contactId,
        payment.customer?.name || data.full_name || data.contactName || 'Contacto sin nombre',
        payment.customer?.phone || data.phone || null,
        'payment-webhook',
        data.date_created || new Date().toISOString()
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

    // Extraer método de pago
    const paymentMethod = payment.method || payment.gateway || payment.payment_method || 'manual';

    // Crear referencia con el número de factura
    const invoiceNumber = payment.invoice?.number || payment.entitySourceMeta?.invoiceNumber || '';
    const reference = invoiceNumber
      ? `Invoice ${invoiceNumber}`
      : payment.reference || paymentId;

    await db.run(query, [
      paymentId,
      contactId,
      payment.total_amount || payment.amount || 0, // HighLevel envía el monto directo, NO en centavos
      payment.currency_code || payment.currency || 'MXN',
      payment.payment_status || payment.status || 'succeeded',
      paymentMethod,
      reference,
      payment.created_at || payment.fulfilledAt || payment.date || payment.createdAt || new Date().toISOString(),
      payment.created_at || payment.createdAt || new Date().toISOString()
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
    const data = req.body;
    const calendar = data.calendar || {};

    // HighLevel manda el ID de la cita en calendar.appointmentId
    const appointmentId = calendar.appointmentId || data.id || data.appointment_id;

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

        const contactQuery = usePostgres
          ? `INSERT INTO contacts (id, full_name, phone, source, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO contacts (id, full_name, phone, source, created_at) VALUES (?, ?, ?, ?, ?)`;

        await db.run(contactQuery, [
          contactId,
          data.full_name || data.contactName || 'Contacto sin nombre',
          data.phone || null,
          'appointment-webhook',
          data.date_created || new Date().toISOString()
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
      appointmentId,
      calendar.id || data.calendarId || data.calendar_id,
      contactId,
      data.location?.id || data.locationId || data.location_id,
      calendar.title || data.title || calendar.calendarName,
      calendar.status || data.status,
      calendar.appoinmentStatus || calendar.appointmentStatus || data.appointment_status,
      calendar.created_by_user_id || data.assignedUserId || data.assigned_user_id,
      calendar.notes || data.notes,
      calendar.address || data.address || data.location?.fullAddress,
      calendar.startTime || data.startTime || data.start_time,
      calendar.endTime || data.endTime || data.end_time,
      calendar.date_created || data.dateAdded || data.date_added || new Date().toISOString(),
      calendar.last_updated || data.dateUpdated || data.date_updated || new Date().toISOString()
    ]);

    // Actualizar appointment_date del contacto con la fecha de la cita más próxima
    const startTime = calendar.startTime || data.startTime || data.start_time;
    if (contactId && startTime) {
      await db.run(`
        UPDATE contacts
        SET appointment_date = ?
        WHERE id = ?
        AND (appointment_date IS NULL OR appointment_date > ?)
      `, [startTime, contactId, startTime]);
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
