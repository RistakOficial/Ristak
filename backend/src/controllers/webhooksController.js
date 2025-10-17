import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { updateSingleContactStats } from '../utils/updateContactsStats.js';
import * as stripeService from '../services/stripeService.js';

/**
 * Procesa webhook de contacto nuevo o actualizado
 */
export const handleContactWebhook = async (req, res) => {
  try {
    const data = req.body;

    // HighLevel puede mandar el ID en diferentes lugares
    const contactId = data.contact_id || data.id || data.contactId;
    const email = data.email;
    const phone = data.phone || data.contactPhone;

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

    // Guardar payment method si viene info de Stripe en el webhook
    try {
      const chargeSnapshot = payment.chargeSnapshot || payment.charge_snapshot || {};

      if (chargeSnapshot.customer && chargeSnapshot.payment_method) {
        // Obtener location_id
        const config = await db.get('SELECT location_id FROM highlevel_config LIMIT 1');

        if (config && config.location_id) {
          // Obtener datos del contacto
          const contact = await db.get('SELECT full_name, email FROM contacts WHERE id = ?', [contactId]);

          const paymentMethodData = chargeSnapshot.payment_method;
          const card = paymentMethodData.card || {};

          // Guardar payment method
          await stripeService.savePaymentMethod({
            locationId: config.location_id,
            contactId: contactId,
            contactName: contact?.full_name || payment.customer?.name || 'Sin nombre',
            contactEmail: contact?.email || payment.customer?.email,
            stripeCustomerId: chargeSnapshot.customer,
            stripePaymentMethodId: paymentMethodData.id || paymentMethodData,
            brand: card.brand || 'unknown',
            last4: card.last4 || '****',
            expMonth: card.exp_month || 12,
            expYear: card.exp_year || 2099,
            isDefault: false
          });

          logger.info(`💳 Payment method guardado automáticamente para contacto ${contactId}`);
        }
      }
    } catch (error) {
      // No fallar el webhook si no se pudo guardar el payment method
      logger.warn(`⚠️  No se pudo guardar payment method del webhook: ${error.message}`);
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
    const eventType = data.type || data.eventType;

    logger.info(`📥 Webhook de invoice recibido: ${eventType || 'sin tipo'}`);

    // Obtener invoice ID
    const invoiceId = data.id || data.invoiceId || data._id;

    if (!invoiceId) {
      logger.warn('Webhook de invoice sin ID, ignorando');
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
        updateFields.payment_method = data.paymentMode || data.payment_mode || 'online';
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
      case 'invoice.deleted':
        // Eliminar de BD local
        await db.run('DELETE FROM payments WHERE ghl_invoice_id = ?', [invoiceId]);
        logger.info(`Invoice ${invoiceId} fue eliminado`);
        return res.status(200).json({ success: true, message: 'Invoice eliminado' });

      default:
        logger.warn(`Tipo de evento de invoice no manejado: ${eventType}`);
        return res.status(200).json({ success: true, message: 'Evento no manejado' });
    }

    if (newStatus) {
      // Construir query de actualización
      const setFields = [`status = ?`];
      const values = [newStatus];

      if (updateFields.sent_at) {
        setFields.push('sent_at = ?');
        values.push(updateFields.sent_at);
      }

      if (updateFields.payment_method) {
        setFields.push('payment_method = ?');
        values.push(updateFields.payment_method);
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
          'SELECT contact_id FROM payments WHERE ghl_invoice_id = ?',
          [invoiceId]
        );

        if (payment && payment.contact_id) {
          await updateSingleContactStats(payment.contact_id);
          logger.success(`Estadísticas actualizadas para contacto: ${payment.contact_id}`);
        }
      }

      // Si fue reembolsado, recalcular estadísticas
      if (newStatus === 'refunded') {
        const payment = await db.get(
          'SELECT contact_id FROM payments WHERE ghl_invoice_id = ?',
          [invoiceId]
        );

        if (payment && payment.contact_id) {
          await updateSingleContactStats(payment.contact_id);
          logger.success(`Estadísticas recalculadas tras reembolso para contacto: ${payment.contact_id}`);
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

    const phone = data.phone || data.contactPhone;

    logger.info(`📥 Webhook de atribución WhatsApp recibido para: ${phone || 'sin teléfono'}`);

    if (!phone) {
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
      phone,
      customData.source_url || data.referral_source_url || data.sourceUrl || data.source_url,
      customData.source_type || data.referral_source_type || data.sourceType || data.source_type,
      customData.source_id || data.referral_source_id || data.sourceId || data.source_id,
      customData.headline || data.referral_headline || data.headline,
      customData.body || data.referral_body || data.body,
      customData.image_url || data.referral_image_url || data.imageUrl || data.image_url,
      customData.video_url || data.referral_video_url || data.videoUrl || data.video_url,
      customData.thumbnail_url || data.referral_thumbnail_url || data.thumbnailUrl || data.thumbnail_url,
      customData.ctwa_clid || data.referral_ctwa_clid || data.ctwa_clid || data.ctwaCLID
    ]);

    logger.info(`✅ Atribución WhatsApp procesada para ${phone} (contacto ${data.contact_id})`);
    res.status(200).json({ success: true, message: 'Atribución procesada' });

  } catch (error) {
    logger.error(`Error en handleWhatsAppAttributionWebhook: ${error.message}`);
    // Siempre devolver 200 para que HighLevel no reintente
    res.status(200).json({ success: true, message: 'Webhook recibido' });
  }
};
