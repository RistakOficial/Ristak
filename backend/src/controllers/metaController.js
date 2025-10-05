import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import {
  saveMetaConfig,
  syncMetaAds,
  getMetaSyncProgress,
  updateRecentAds
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

    res.json({
      success: true,
      configured: true,
      config: {
        adAccountId: config.ad_account_id,
        accessToken: config.access_token.substring(0, 10) + '...',
        appId: config.app_id,
        appSecret: config.app_secret ? config.app_secret.substring(0, 10) + '...' : null,
        updatedAt: config.updated_at
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

    // Query para obtener datos agregados por campaña, adset y ad
    const aggregationQuery = `
      SELECT
        campaign_id, campaign_name,
        adset_id, adset_name,
        ad_id, ad_name,
        SUM(spend) as spend,
        SUM(reach) as reach,
        SUM(clicks) as clicks,
        AVG(cpc) as cpc,
        AVG(cpm) as cpm
      FROM meta_ads
      WHERE date BETWEEN ? AND ?
      GROUP BY campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name
      ORDER BY campaign_id, adset_id, ad_id
    `;

    const rows = await db.all(aggregationQuery, [adsStart, adsEnd]);

    // Obtener interesados y ventas por ad_id
    const contactsQuery = `
      SELECT
        attribution_ad_id as ad_id,
        COUNT(*) as interesados,
        COUNT(CASE WHEN purchases_count > 0 THEN 1 END) as ventas,
        COALESCE(SUM(total_paid), 0) as revenue
      FROM contacts
      WHERE attribution_ad_id IS NOT NULL
      AND created_at >= ?
      AND created_at <= ?
      GROUP BY attribution_ad_id
    `;

    const contactsData = await db.all(contactsQuery, [
      range.startUtc,
      range.endUtc
    ]);

    // Crear un mapa de ad_id -> {interesados, ventas, revenue}
    const contactsMap = {};
    contactsData.forEach(row => {
      contactsMap[row.ad_id] = {
        interesados: parseInt(row.interesados) || 0,
        ventas: parseInt(row.ventas) || 0,
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
          ads: []
        };
      }

      const adset = campaign.adsets[row.adset_id];

      // Obtener datos de contactos para este ad
      const contactData = contactsMap[row.ad_id] || { interesados: 0, ventas: 0, revenue: 0 };

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
        leads: contactData.interesados
      });

      // Sumar a adset
      adset.spend += parseFloat(row.spend) || 0;
      adset.reach += parseInt(row.reach) || 0;
      adset.clicks += parseInt(row.clicks) || 0;
      adset.revenue += contactData.revenue;
      adset.sales += contactData.ventas;
      adset.leads += contactData.interesados;

      // Sumar a campaña
      campaign.spend += parseFloat(row.spend) || 0;
      campaign.reach += parseInt(row.reach) || 0;
      campaign.clicks += parseInt(row.clicks) || 0;
      campaign.revenue += contactData.revenue;
      campaign.sales += contactData.ventas;
      campaign.leads += contactData.interesados;
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
          TO_CHAR(date, 'YYYY-MM-DD') as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date >= $1 AND date < ($2::date + INTERVAL '1 day')
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

    // Query de ingresos (adaptado a PostgreSQL o SQLite)
    const revenueQuery = usePostgres
      ? `
        SELECT
          TO_CHAR(date, 'YYYY-MM-DD') as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date >= $1 AND date < ($2::date + INTERVAL '1 day')
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          strftime('%Y-%m-%d', date) as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date >= ? AND date < DATE(?, '+1 day')
        GROUP BY day
        ORDER BY day ASC
      `;
    const revenueParams = [start, end];

    const [spendData, revenueData] = await Promise.all([
      db.all(spendQuery, spendParams),
      db.all(revenueQuery, revenueParams)
    ]);

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

    const adIdsFilters = ['date BETWEEN ? AND ?'];
    const adIdsParams = [adsStart, adsEnd];

    // Obtener los ad_ids relevantes basándose en el filtro
    if (ad_id) {
      adIdsFilters.push('ad_id = ?');
      adIdsParams.push(ad_id);
    } else if (adset_id) {
      adIdsFilters.push('adset_id = ?');
      adIdsParams.push(adset_id);
    } else if (campaign_id) {
      adIdsFilters.push('campaign_id = ?');
      adIdsParams.push(campaign_id);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Se requiere al menos campaign_id, adset_id o ad_id'
      });
    }

    const adIdsQuery = `
      SELECT DISTINCT ad_id
      FROM meta_ads
      WHERE ${adIdsFilters.join(' AND ')}
    `;

    const adIds = await db.all(adIdsQuery, adIdsParams);
    const adIdsList = adIds.map(row => row.ad_id);

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
