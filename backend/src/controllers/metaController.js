import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isEncrypted } from '../utils/encryption.js';
import {
  saveMetaConfig,
  syncMetaAds,
  getMetaSyncProgress,
  updateRecentAds,
  getMetaConfig,
  verifyMetaToken
} from '../services/metaAdsService.js';
import { resolveDateRange } from '../utils/dateUtils.js';

/**
 * Guarda la configuración de Meta Ads
 */
export const saveConfig = async (req, res) => {
  try {
    const { ad_account_id, access_token, app_id, app_secret } = req.body;

    if (!ad_account_id || !access_token) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren ad_account_id y access_token'
      });
    }

    logger.info(`Guardando configuración de Meta para account: ${ad_account_id}`);

    await saveMetaConfig({
      ad_account_id,
      access_token,
      app_id: app_id || null,
      app_secret: app_secret || null
    });

    logger.info('Configuración de Meta guardada exitosamente');

    res.json({
      success: true,
      message: 'Configuración de Meta guardada exitosamente'
    });

  } catch (error) {
    logger.error(`Error en saveConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar la configuración de Meta'
    });
  }
};

/**
 * Obtiene la configuración de Meta (sin exponer el token completo)
 */
export const getConfig = async (req, res) => {
  try {
    const config = await db.get(
      'SELECT ad_account_id, access_token, app_id, app_secret, updated_at FROM meta_config LIMIT 1'
    );

    if (!config) {
      return res.json({
        success: true,
        configured: false,
        config: null
      });
    }

    // Verificar si está encriptado
    const tokenEncrypted = isEncrypted(config.access_token);
    const secretEncrypted = config.app_secret ? isEncrypted(config.app_secret) : false;

    res.json({
      success: true,
      configured: true,
      config: {
        adAccountId: config.ad_account_id,
        accessToken: '***' + config.access_token.substring(config.access_token.length - 8),
        appId: config.app_id,
        appSecret: config.app_secret ? '***' + config.app_secret.substring(config.app_secret.length - 8) : null,
        updatedAt: config.updated_at,
        isEncrypted: tokenEncrypted, // Mostrar si está encriptado
        secretIsEncrypted: secretEncrypted
      }
    });

  } catch (error) {
    logger.error(`Error en getConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener la configuración de Meta'
    });
  }
};

/**
 * Sincroniza anuncios de Meta desde una fecha específica
 */
export const syncAds = async (req, res) => {
  try {
    const { startDate } = req.body;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate (formato: YYYY-MM-DD)'
      });
    }

    logger.info(`Iniciando sincronización de Meta Ads desde: ${startDate}`);

    // Iniciar sincronización (no esperar a que termine)
    syncMetaAds(startDate).catch(error => {
      logger.error(`Error en syncMetaAds: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Sincronización de Meta Ads iniciada. Usa getSyncProgress para ver el progreso.'
    });

  } catch (error) {
    logger.error(`Error en syncAds: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar la sincronización de Meta Ads'
    });
  }
};

/**
 * Obtiene el progreso actual de la sincronización de Meta
 */
export const getSyncProgressEndpoint = async (req, res) => {
  try {
    const progress = getMetaSyncProgress();

    res.json({
      success: true,
      progress
    });

  } catch (error) {
    logger.error(`Error en getSyncProgress: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el progreso de sincronización'
    });
  }
};

/**
 * Actualiza anuncios recientes (para cron job)
 */
export const updateRecent = async (req, res) => {
  try {
    logger.info('Actualizando anuncios recientes de Meta');

    await updateRecentAds();

    res.json({
      success: true,
      message: 'Anuncios recientes actualizados exitosamente'
    });

  } catch (error) {
    logger.error(`Error en updateRecent: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar anuncios recientes'
    });
  }
};

/**
 * Obtiene campañas con sus adsets y ads en estructura jerárquica
 */
export const getCampaigns = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const range = resolveDateRange({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const adsStart = range.startZoned.toISODate();
    const adsEnd = range.endZoned.toISODate();

    logger.info(`Obteniendo campañas Meta - rango: ${adsStart} -> ${adsEnd}`);

    // Primero obtener interesados, ventas y citas por ad_id
    // IMPORTANTE: La columna "citas" cuenta contactos con AL MENOS 1 cita (no el total de citas)
    // Se basa en la FECHA DE CREACIÓN DEL CONTACTO para medir atribución de marketing correctamente:
    // - Si un contacto se creó el 1-enero y agendó cita el 15-febrero, se atribuye al 1-enero
    // - Esto mide el impacto real de las campañas en generar citas (atribución correcta)
    // - Un contacto con 1000 citas cuenta como 1 solo contacto (métrica binaria: tiene o no tiene cita)

    // PASO 1: Obtener métricas básicas y contactos que YA tienen citas en DB
    const contactsQuery = `
      SELECT
        c.attribution_ad_id as ad_id,
        c.id as contact_id,
        c.purchases_count,
        c.total_paid,
        CASE WHEN a.contact_id IS NOT NULL THEN 1 ELSE 0 END as has_appointment_db
      FROM contacts c
      LEFT JOIN (
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE contact_id IS NOT NULL
      ) a ON a.contact_id = c.id
      WHERE c.attribution_ad_id IS NOT NULL
      AND c.created_at >= ?
      AND c.created_at <= ?
    `;

    const contactsRaw = await db.all(contactsQuery, [
      range.startUtc,
      range.endUtc
    ]);

    logger.info(`[CITAS] Total contactos con ad_id en período: ${contactsRaw.length}`);
    logger.info(`[CITAS] Contactos CON citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 1).length}`);
    logger.info(`[CITAS] Contactos SIN citas en DB: ${contactsRaw.filter(c => c.has_appointment_db === 0).length}`);

    // PASO 2: Para contactos sin citas en DB, verificar en HighLevel API (fallback)
    // Solo hacer esto si tenemos configuración de HighLevel
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const contactsWithAppointments = new Set();

    // Primero agregar los que ya tienen citas en DB
    contactsRaw.forEach(c => {
      if (c.has_appointment_db === 1) {
        contactsWithAppointments.add(c.contact_id);
      }
    });

    // Obtener contactos que NO tienen citas en DB para verificar en HighLevel
    const contactsToCheck = contactsRaw.filter(c => c.has_appointment_db === 0);

    if (config && config.api_token && contactsToCheck.length > 0) {
      // Batch de 50 contactos simultáneos (HighLevel permite 200k requests/día)
      // Con 50 paralelas, podemos verificar 3000 contactos por minuto sin problemas
      const batchSize = 50;
      logger.info(`[CITAS] Verificando ${contactsToCheck.length} contactos sin citas en DB...`);

      for (let i = 0; i < contactsToCheck.length; i += batchSize) {
        const batch = contactsToCheck.slice(i, i + batchSize);
        const progress = Math.min(i + batchSize, contactsToCheck.length);
        logger.info(`[CITAS] Procesando batch ${Math.floor(i/batchSize) + 1}: ${progress}/${contactsToCheck.length} contactos...`);

        // Hacer llamadas en paralelo para este batch
        const appointmentChecks = await Promise.all(
          batch.map(async (contact) => {
            try {
              const response = await fetch(
                `https://services.leadconnectorhq.com/contacts/${contact.contact_id}/appointments`,
                {
                  headers: {
                    'Authorization': `Bearer ${config.api_token}`,
                    'Version': '2021-07-28'
                  }
                }
              );

              if (response.ok) {
                const data = await response.json();
                if (data.events && data.events.length > 0) {
                  // Este contacto SÍ tiene citas en HighLevel
                  logger.info(`[CITAS] Contacto ${contact.contact_id} tiene ${data.events.length} citas en HighLevel (no en DB)`);

                  // Opcionalmente guardar en DB para cache futuro
                  for (const event of data.events) {
                    await db.run(`
                      INSERT INTO appointments (id, contact_id, calendar_id, location_id, title, status, start_time, end_time)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET
                        status = excluded.status,
                        start_time = excluded.start_time,
                        end_time = excluded.end_time
                    `, [
                      event.id,
                      contact.contact_id,
                      event.calendarId || '',
                      event.locationId || config.location_id,
                      event.title || '',
                      event.status || 'scheduled',
                      event.startTime || '',
                      event.endTime || ''
                    ]).catch(err => {
                      logger.error(`Error guardando cita ${event.id}:`, err);
                    });
                  }

                  return { contactId: contact.contact_id, hasAppointments: true };
                }
              }
              return { contactId: contact.contact_id, hasAppointments: false };
            } catch (error) {
              logger.error(`Error verificando citas para contacto ${contact.contact_id}:`, error);
              return { contactId: contact.contact_id, hasAppointments: false };
            }
          })
        );

        // Actualizar el set con los contactos que tienen citas
        appointmentChecks.forEach(result => {
          if (result.hasAppointments) {
            contactsWithAppointments.add(result.contactId);
          }
        });

        logger.info(`[CITAS] Batch ${Math.floor(i/batchSize) + 1} completado. Total con citas hasta ahora: ${contactsWithAppointments.size}`);
      }

      logger.info(`[CITAS] Fallback completado. Total contactos con citas (DB + API): ${contactsWithAppointments.size}`);
    } else {
      if (contactsToCheck.length > 0) {
        logger.info(`[CITAS] No se puede hacer fallback: ${!config ? 'Sin config de HighLevel' : 'Sin API token'}`);
      }
    }

    // PASO 3: Agrupar métricas por ad_id
    const metricsMap = {};
    contactsRaw.forEach(c => {
      if (!metricsMap[c.ad_id]) {
        metricsMap[c.ad_id] = {
          interesados: new Set(),
          ventas: new Set(),
          citas: new Set(),
          revenue: 0
        };
      }

      metricsMap[c.ad_id].interesados.add(c.contact_id);

      if (c.purchases_count > 0) {
        metricsMap[c.ad_id].ventas.add(c.contact_id);
      }

      if (contactsWithAppointments.has(c.contact_id)) {
        metricsMap[c.ad_id].citas.add(c.contact_id);
      }

      metricsMap[c.ad_id].revenue += parseFloat(c.total_paid || 0);
    });

    // Convertir a formato esperado
    const contactsData = Object.keys(metricsMap).map(ad_id => ({
      ad_id,
      interesados: metricsMap[ad_id].interesados.size,
      ventas: metricsMap[ad_id].ventas.size,
      citas: metricsMap[ad_id].citas.size,
      revenue: metricsMap[ad_id].revenue
    }));

    logger.info(`[CITAS RESUMEN] Total contactos con citas: ${contactsWithAppointments.size}/${contactsRaw.length} (${Math.round(contactsWithAppointments.size * 100 / Math.max(contactsRaw.length, 1))}%)`);

    // Log desglose por ad_id con citas
    const adsWithAppointments = contactsData.filter(ad => ad.citas > 0);
    if (adsWithAppointments.length > 0) {
      logger.info(`[CITAS RESUMEN] ${adsWithAppointments.length} ads con citas:`,
        adsWithAppointments.map(ad => `Ad ${ad.ad_id}: ${ad.citas} contactos con citas`).join(', ')
      );
    }

    // Obtener todos los ad_ids que tienen contactos en el período
    const adIdsWithContacts = contactsData.map(row => row.ad_id).filter(Boolean);

    // Query para obtener datos agregados por campaña, adset y ad
    // SOLO incluir gasto del período (sin OR que incluya fechas fuera del rango)
    const aggregationQuery = `
      SELECT DISTINCT
        m.campaign_id, m.campaign_name,
        m.adset_id, m.adset_name,
        m.ad_id, m.ad_name,
        COALESCE(SUM(m.spend), 0) as spend,
        COALESCE(SUM(m.reach), 0) as reach,
        COALESCE(SUM(m.clicks), 0) as clicks,
        AVG(m.cpc) as cpc,
        AVG(m.cpm) as cpm
      FROM meta_ads m
      WHERE m.date BETWEEN ? AND ?
      GROUP BY m.campaign_id, m.campaign_name, m.adset_id, m.adset_name, m.ad_id, m.ad_name
      ORDER BY m.campaign_id, m.adset_id, m.ad_id
    `;

    // Parámetros: solo el rango para el WHERE
    const aggregationParams = [
      adsStart, adsEnd
    ];

    const rows = await db.all(aggregationQuery, aggregationParams);

    // Crear un mapa de ad_id -> {interesados, ventas, citas, revenue}
    const contactsMap = {};
    contactsData.forEach(row => {
      contactsMap[row.ad_id] = {
        interesados: parseInt(row.interesados) || 0,
        ventas: parseInt(row.ventas) || 0,
        citas: parseInt(row.citas) || 0,
        revenue: parseFloat(row.revenue) || 0
      };
    });

    // Agrupar por campañas -> adsets -> ads
    const campaigns = {};

    rows.forEach(row => {
      // Crear campaña si no existe
      if (!campaigns[row.campaign_id]) {
        campaigns[row.campaign_id] = {
          id: row.campaign_id,
          name: row.campaign_name,
          spend: 0,
          reach: 0,
          clicks: 0,
          cpc: 0,
          cpm: 0,
          impressions: 0,
          revenue: 0,
          roas: 0,
          sales: 0,
          leads: 0,
          appointments: 0,
          adsets: {}
        };
      }

      const campaign = campaigns[row.campaign_id];

      // Crear adset si no existe
      if (!campaign.adsets[row.adset_id]) {
        campaign.adsets[row.adset_id] = {
          id: row.adset_id,
          name: row.adset_name,
          spend: 0,
          reach: 0,
          clicks: 0,
          cpc: 0,
          cpm: 0,
          impressions: 0,
          revenue: 0,
          roas: 0,
          sales: 0,
          leads: 0,
          appointments: 0,
          ads: []
        };
      }

      const adset = campaign.adsets[row.adset_id];

      // Obtener datos de contactos para este ad
      const contactData = contactsMap[row.ad_id] || { interesados: 0, ventas: 0, citas: 0, revenue: 0 };

      // Agregar ad
      adset.ads.push({
        id: row.ad_id,
        name: row.ad_name,
        spend: parseFloat(row.spend) || 0,
        reach: parseInt(row.reach) || 0,
        clicks: parseInt(row.clicks) || 0,
        cpc: parseFloat(row.cpc) || 0,
        cpm: parseFloat(row.cpm) || 0,
        impressions: 0,
        revenue: contactData.revenue,
        roas: parseFloat(row.spend) > 0 ? contactData.revenue / parseFloat(row.spend) : 0,
        sales: contactData.ventas,
        leads: contactData.interesados,
        appointments: contactData.citas
      });

      // Sumar a adset
      adset.spend += parseFloat(row.spend) || 0;
      adset.reach += parseInt(row.reach) || 0;
      adset.clicks += parseInt(row.clicks) || 0;
      adset.revenue += contactData.revenue;
      adset.sales += contactData.ventas;
      adset.leads += contactData.interesados;
      adset.appointments = (adset.appointments || 0) + contactData.citas;

      // Sumar a campaña
      campaign.spend += parseFloat(row.spend) || 0;
      campaign.reach += parseInt(row.reach) || 0;
      campaign.clicks += parseInt(row.clicks) || 0;
      campaign.revenue += contactData.revenue;
      campaign.sales += contactData.ventas;
      campaign.leads += contactData.interesados;
      campaign.appointments = (campaign.appointments || 0) + contactData.citas;
    });

    // Convertir objetos a arrays y calcular promedios
    const campaignsArray = Object.values(campaigns).map(campaign => {
      const adsets = Object.values(campaign.adsets);

      // Calcular CPC/CPM promedio para la campaña
      if (adsets.length > 0) {
        const totalAds = adsets.reduce((sum, adset) => sum + adset.ads.length, 0);
        if (totalAds > 0) {
          campaign.cpc = adsets.reduce((sum, adset) =>
            sum + adset.ads.reduce((s, ad) => s + (ad.cpc || 0), 0), 0) / totalAds;
          campaign.cpm = adsets.reduce((sum, adset) =>
            sum + adset.ads.reduce((s, ad) => s + (ad.cpm || 0), 0), 0) / totalAds;
        }
      }

      // Calcular ROAS para la campaña
      campaign.roas = campaign.spend > 0 ? campaign.revenue / campaign.spend : 0;

      // Calcular CPC/CPM/ROAS promedio para cada adset
      adsets.forEach(adset => {
        if (adset.ads.length > 0) {
          adset.cpc = adset.ads.reduce((sum, ad) => sum + (ad.cpc || 0), 0) / adset.ads.length;
          adset.cpm = adset.ads.reduce((sum, ad) => sum + (ad.cpm || 0), 0) / adset.ads.length;
        }
        // Calcular ROAS para el adset
        adset.roas = adset.spend > 0 ? adset.revenue / adset.spend : 0;
      });

      return {
        ...campaign,
        adsets
      };
    });

    res.json({
      success: true,
      data: campaignsArray
    });

  } catch (error) {
    logger.error(`Error en getCampaigns: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener campañas'
    });
  }
};

/**
 * Obtiene gastos agrupados por período (para gráficas)
 */
export const getSpendOverTime = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const range = resolveDateRange({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const start = range.startZoned.toISODate();
    const end = range.endZoned.toISODate();

    logger.info(`Obteniendo gastos e ingresos desde ${start} hasta ${end}`);

    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Query de gastos (adaptado a PostgreSQL o SQLite)
    const spendQuery = usePostgres
      ? `
        SELECT
          TO_CHAR(date::date, 'YYYY-MM-DD') as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date::date >= $1::date AND date::date < ($2::date + INTERVAL '1 day')
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          strftime('%Y-%m-%d', date) as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date >= ? AND date < DATE(?, '+1 day')
        GROUP BY day
        ORDER BY day ASC
      `;
    const spendParams = [start, end];

    // Query de ingresos ATRIBUIDOS basado en fecha de CREACIÓN del contacto y su LTV total
    // Usamos la fecha cuando el contacto llegó (created_at) y sumamos su valor total acumulado (total_paid)
    const revenueQuery = usePostgres
      ? `
        SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          SUM(total_paid) as revenue
        FROM contacts
        WHERE attribution_ad_id IS NOT NULL
          AND attribution_ad_id != ''
          AND created_at::date >= $1::date
          AND created_at::date < ($2::date + INTERVAL '1 day')
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          strftime('%Y-%m-%d', created_at) as day,
          SUM(total_paid) as revenue
        FROM contacts
        WHERE attribution_ad_id IS NOT NULL
          AND attribution_ad_id != ''
          AND date(created_at) >= date(?)
          AND date(created_at) < date(?, '+1 day')
        GROUP BY day
        ORDER BY day ASC
      `;
    const revenueParams = [start, end];

    const [spendData, revenueData] = await Promise.all([
      db.all(spendQuery, spendParams),
      db.all(revenueQuery, revenueParams)
    ]);

    logger.info(`Gastos encontrados: ${spendData.length} días con datos`);
    logger.info(`Contactos atribuidos con LTV encontrados: ${revenueData.length} días con nuevos contactos que han generado ingresos`);

    // Si no hay datos de ningún tipo, retornar vacío
    if (spendData.length === 0 && revenueData.length === 0) {
      logger.info('No hay datos de publicidad ni ingresos atribuidos para el período solicitado');
      return res.json({
        success: true,
        data: []
      });
    }

    // Crear un mapa de ingresos por fecha
    const revenueMap = new Map();
    revenueData.forEach(row => {
      revenueMap.set(row.day, parseFloat(row.revenue || 0));
    });

    // Crear un mapa de gastos por fecha
    const spendMap = new Map();
    spendData.forEach(row => {
      spendMap.set(row.day, parseFloat(row.spend || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...revenueMap.keys(), ...spendMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend: { label, value, value2 }
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: revenueMap.get(date) || 0, // Ingresos
      value2: spendMap.get(date) || 0     // Gastos
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getSpendOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener gastos por período'
    });
  }
};

/**
 * Obtiene el estado actual de sincronización de Meta
 */
export const getSyncStatus = async (req, res) => {
  try {
    const progress = getMetaSyncProgress();

    // Mapear el status interno al formato esperado por el frontend
    let status = 'idle';
    if (progress.status === 'syncing') {
      status = 'syncing';
    } else if (progress.status === 'completed') {
      status = 'completed';
    }

    // Calcular el porcentaje de progreso
    let progressPercent = 0;
    if (progress.monthsTotal > 0) {
      progressPercent = Math.round((progress.monthsCurrent / progress.monthsTotal) * 100);
    }

    res.json({
      success: true,
      status,
      progress: progressPercent,
      details: {
        step: progress.step,
        message: progress.message,
        monthsCurrent: progress.monthsCurrent,
        monthsTotal: progress.monthsTotal
      }
    });

  } catch (error) {
    logger.error(`Error en getSyncStatus: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el estado de sincronización'
    });
  }
};

/**
 * Obtiene contactos por tipo (interesados o ventas) filtrados por campaign/adset/ad
 */
export const getContactsByType = async (req, res) => {
  try {
    const { type, startDate, endDate, campaign_id, adset_id, ad_id } = req.query;

    if (!type || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren type, startDate y endDate'
      });
    }

    const range = resolveDateRange({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const adsStart = range.startZoned.toISODate();
    const adsEnd = range.endZoned.toISODate();

    let adIdsList = [];

    // Obtener los ad_ids relevantes basándose en el filtro
    if (ad_id) {
      // Si se especifica un ad_id directamente, usarlo sin filtrar por fechas en meta_ads
      adIdsList = [ad_id];
    } else if (adset_id) {
      // Si se especifica un adset_id, obtener todos los ads de ese adset (sin filtrar por fecha)
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE adset_id = ?
      `;
      const adIds = await db.all(adIdsQuery, [adset_id]);
      adIdsList = adIds.map(row => row.ad_id);
    } else if (campaign_id) {
      // Si se especifica un campaign_id, obtener todos los ads de esa campaña (sin filtrar por fecha)
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE campaign_id = ?
      `;
      const adIds = await db.all(adIdsQuery, [campaign_id]);
      adIdsList = adIds.map(row => row.ad_id);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Se requiere al menos campaign_id, adset_id o ad_id'
      });
    }

    if (adIdsList.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Construir query de contactos
    const placeholders = adIdsList.map(() => '?').join(',');
    let contactsQuery = `
      SELECT
        id,
        full_name,
        email,
        phone,
        attribution_ad_id,
        attribution_ad_name,
        total_paid,
        purchases_count,
        created_at
      FROM contacts
      WHERE attribution_ad_id IN (${placeholders})
      AND created_at >= ?
      AND created_at <= ?
    `;

    if (type === 'sales') {
      contactsQuery += ' AND purchases_count > 0';
    }

    contactsQuery += ' ORDER BY created_at DESC';

    const contactsParams = [...adIdsList, range.startUtc, range.endUtc];
    const contacts = await db.all(contactsQuery, contactsParams);

    const contactIds = contacts.map(contact => contact.id).filter(Boolean);

    let paymentsMap = new Map();

    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => '?').join(',');
      const paymentConditions = [`contact_id IN (${placeholders})`];
      const paymentParams = [...contactIds];

      if (range.startUtc) {
        paymentConditions.push('date >= ?');
        paymentParams.push(range.startUtc);
      }

      if (range.endUtc) {
        paymentConditions.push('date <= ?');
        paymentParams.push(range.endUtc);
      }

      const paymentsQuery = `
        SELECT
          id,
          contact_id,
          amount,
          status,
          date
        FROM payments
        WHERE ${paymentConditions.join(' AND ')}
        ORDER BY date DESC
      `;

      const paymentRows = await db.all(paymentsQuery, paymentParams);

      paymentsMap = paymentRows.reduce((map, payment) => {
        const list = map.get(payment.contact_id) || [];
        list.push({
          id: payment.id,
          amount: Number(payment.amount || 0),
          status: payment.status,
          date: payment.date
        });
        map.set(payment.contact_id, list);
        return map;
      }, new Map());
    }

    const mappedContacts = contacts.map(contact => {
      const payments = paymentsMap.get(contact.id) || [];
      const totalFromPayments = payments.reduce((sum, payment) => sum + payment.amount, 0);
      const totalPaid = contact.total_paid ? Number(contact.total_paid) : totalFromPayments;

      return {
        id: contact.id,
        name: contact.full_name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        created_at: contact.created_at,
        ltv: totalPaid,
        ad_id: contact.attribution_ad_id,
        ad_name: contact.attribution_ad_name,
        is_sale: contact.purchases_count > 0,
        payments: payments
      };
    });

    logger.debug(
      `Contactos Meta ${type} (${adsStart} -> ${adsEnd}) -> ${mappedContacts.length} coincidencias`
    );

    res.json({
      success: true,
      data: mappedContacts
    });

  } catch (error) {
    logger.error(`Error en getContactsByType: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener contactos'
    });
  }
};

/**
 * Verifica el estado del token de Meta (validez, expiración, scopes)
 */
export const verifyToken = async (req, res) => {
  try {
    const config = await getMetaConfig();

    if (!config || !config.access_token) {
      return res.json({
        success: true,
        configured: false,
        tokenStatus: {
          valid: false,
          message: 'No hay token configurado'
        }
      });
    }

    logger.info('Verificando validez del token de Meta...');

    const validation = await verifyMetaToken(config.access_token);

    let message = '';
    let daysUntilExpiry = null;

    if (!validation.valid) {
      message = validation.error || 'Token inválido o expirado';
    } else if (validation.expiresAt) {
      daysUntilExpiry = Math.ceil((validation.expiresAt - new Date()) / (1000 * 60 * 60 * 24));

      if (daysUntilExpiry <= 0) {
        message = 'Token expirado';
      } else if (daysUntilExpiry <= 7) {
        message = `Token válido pero expira en ${daysUntilExpiry} días. Considera renovarlo.`;
      } else {
        message = `Token válido (expira en ${daysUntilExpiry} días)`;
      }
    } else {
      message = 'Token válido (sin fecha de expiración)';
    }

    res.json({
      success: true,
      configured: true,
      tokenStatus: {
        valid: validation.valid,
        message,
        expiresAt: validation.expiresAt,
        daysUntilExpiry,
        scopes: validation.scopes || []
      }
    });

  } catch (error) {
    logger.error(`Error en verifyToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al verificar el token de Meta'
    });
  }
};

/**
 * Obtiene leads vs citas agrupados por fecha de creación
 */
export const getLeadsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;
    const usePostgres = true; // Render always uses PostgreSQL

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = resolveDateRange({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    // Query para obtener contactos únicos con citas por fecha de creación
    const appointmentsQuery = usePostgres
      ? `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(c.created_at) as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND DATE(c.created_at) >= DATE(?)
           AND DATE(c.created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    const params = [startUtc, endUtc];
    const [leadsData, appointmentsData] = await Promise.all([
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, params)
    ]);

    // Crear mapas para combinar los datos
    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...leadsMap.keys(), ...appointmentsMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: leadsMap.get(date) || 0,       // Leads
      value2: appointmentsMap.get(date) || 0 // Citas
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getLeadsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener leads vs citas por período'
    });
  }
};

/**
 * Obtiene citas vs ventas agrupadas por fecha de creación
 */
export const getAppointmentsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;
    const usePostgres = true; // Render always uses PostgreSQL

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = resolveDateRange({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Query para obtener contactos únicos con citas por fecha de creación
    const appointmentsQuery = usePostgres
      ? `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(c.created_at) as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND DATE(c.created_at) >= DATE(?)
           AND DATE(c.created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    // Query para obtener ventas (contactos con purchases_count > 0) por fecha de creación
    const salesQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT id) as sales
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND purchases_count > 0
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT id) as sales
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND purchases_count > 0
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    const params = [startUtc, endUtc];
    const [appointmentsData, salesData] = await Promise.all([
      db.all(appointmentsQuery, params),
      db.all(salesQuery, params)
    ]);

    // Crear mapas para combinar los datos
    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    const salesMap = new Map();
    salesData.forEach(row => {
      salesMap.set(row.day, parseInt(row.sales || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...appointmentsMap.keys(), ...salesMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: appointmentsMap.get(date) || 0,  // Citas
      value2: salesMap.get(date) || 0         // Ventas
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getAppointmentsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener citas vs ventas por período'
    });
  }
};

/**
 * Obtiene visitantes vs leads agrupados por fecha
 */
export const getVisitorsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;
    const usePostgres = true; // Render always uses PostgreSQL

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = resolveDateRange({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Query para obtener visitantes únicos por fecha desde sessions
    const visitorsQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT visitor_id) as visitors
         FROM sessions
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT visitor_id) as visitors
         FROM sessions
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day
         ORDER BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day
         ORDER BY day`;

    const params = [startUtc, endUtc];
    const [visitorsData, leadsData] = await Promise.all([
      db.all(visitorsQuery, params),
      db.all(leadsQuery, params)
    ]);

    // Crear mapas para combinar los datos
    const visitorsMap = new Map();
    visitorsData.forEach(row => {
      visitorsMap.set(row.day, parseInt(row.visitors || 0));
    });

    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...visitorsMap.keys(), ...leadsMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: visitorsMap.get(date) || 0,   // Visitantes
      value2: leadsMap.get(date) || 0      // Leads
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getVisitorsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener visitantes vs leads por período'
    });
  }
};

/**
 * Obtiene todas las métricas del funnel agrupadas por fecha
 */
export const getFunnelMetrics = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;
    const usePostgres = true; // Render always uses PostgreSQL

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = resolveDateRange({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Query para visitantes únicos CON attribution_ad_id
    const visitorsQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT visitor_id) as visitors
         FROM sessions
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT visitor_id) as visitors
         FROM sessions
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day`;

    // Query para leads CON attribution_ad_id
    const leadsQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT id) as leads
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day`;

    // Query para contactos con citas CON attribution_ad_id
    const appointmentsQuery = usePostgres
      ? `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day`
      : `SELECT
          DATE(c.created_at) as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND DATE(c.created_at) >= DATE(?)
           AND DATE(c.created_at) <= DATE(?)
         GROUP BY day`;

    // Query para ventas CON attribution_ad_id
    const salesQuery = usePostgres
      ? `SELECT
          TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT id) as sales
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND purchases_count > 0
           AND created_at::date >= $1::date
           AND created_at::date < ($2::date + INTERVAL '1 day')
         GROUP BY day`
      : `SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT id) as sales
         FROM contacts
         WHERE attribution_ad_id IS NOT NULL
           AND attribution_ad_id != ''
           AND purchases_count > 0
           AND DATE(created_at) >= DATE(?)
           AND DATE(created_at) <= DATE(?)
         GROUP BY day`;

    const params = [startUtc, endUtc];
    const [visitorsData, leadsData, appointmentsData, salesData] = await Promise.all([
      db.all(visitorsQuery, params),
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, params),
      db.all(salesQuery, params)
    ]);

    // Crear mapas para cada métrica
    const visitorsMap = new Map();
    visitorsData.forEach(row => {
      visitorsMap.set(row.day, parseInt(row.visitors || 0));
    });

    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    const salesMap = new Map();
    salesData.forEach(row => {
      salesMap.set(row.day, parseInt(row.sales || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([
      ...visitorsMap.keys(),
      ...leadsMap.keys(),
      ...appointmentsMap.keys(),
      ...salesMap.keys()
    ]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado con todas las métricas
    const mappedData = sortedDates.map(date => ({
      label: date,
      visitors: visitorsMap.get(date) || 0,
      leads: leadsMap.get(date) || 0,
      appointments: appointmentsMap.get(date) || 0,
      sales: salesMap.get(date) || 0
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getFunnelMetrics: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener métricas del funnel'
    });
  }
};

