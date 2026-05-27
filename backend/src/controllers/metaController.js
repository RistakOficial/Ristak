import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isEncrypted } from '../utils/encryption.js';
import {
  saveMetaConfig,
  syncMetaAds,
  getMetaSyncProgress,
  getMetaConfig,
  verifyMetaToken
} from '../services/metaAdsService.js';
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js';
import { getContactsWithAppointmentsHybrid } from '../services/appointmentsMerge.js';
import { fetchAndSaveMetaConfig } from '../services/highlevelSyncService.js';
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js';
import { API_URLS } from '../config/constants.js';
import fetch from 'node-fetch';

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]|null>} Array de calendar IDs o null si no están configurados
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    );

    if (!config || !config.config_value) {
      return null; // null = usar todos los calendarios
    }

    const calendarIds = JSON.parse(config.config_value);
    return calendarIds.length > 0 ? calendarIds : null;
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución: ${error.message}`);
    return null;
  }
}

/**
 * Guarda la configuración de Meta Ads
 * USA System User Token (no requiere App ID ni App Secret)
 */
export const saveConfig = async (req, res) => {
  try {
    const { ad_account_id, access_token, pixel_id, pixel_api_token, page_id } = req.body;

    if (!ad_account_id || !access_token) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren ad_account_id y access_token'
      });
    }

    logger.info(`Guardando configuración de Meta para account: ${ad_account_id}${pixel_id ? ` con pixel: ${pixel_id}` : ''}${page_id ? ` con page: ${page_id}` : ''}${pixel_api_token ? ' (con Pixel API Token para Conversions API)' : ''}`);

    await saveMetaConfig(
      ad_account_id,
      access_token,
      pixel_id || null,
      pixel_api_token || null,
      page_id || null
    );

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
      'SELECT ad_account_id, access_token, pixel_id, pixel_api_token, page_id, timezone_id, timezone_name, timezone_offset_hours_utc, updated_at FROM meta_config LIMIT 1'
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
    const pixelApiTokenEncrypted = config.pixel_api_token ? isEncrypted(config.pixel_api_token) : false;

    res.json({
      success: true,
      configured: true,
      config: {
        adAccountId: config.ad_account_id,
        accessToken: '***' + config.access_token.substring(config.access_token.length - 8),
        pixelId: config.pixel_id || null,
        pageId: config.page_id || null,
        pixelApiToken: config.pixel_api_token ? '***' + config.pixel_api_token.substring(config.pixel_api_token.length - 8) : null,
        updatedAt: config.updated_at,
        isEncrypted: tokenEncrypted, // Mostrar si está encriptado
        pixelApiTokenIsEncrypted: pixelApiTokenEncrypted,
        // Timezone info
        timezoneId: config.timezone_id,
        timezoneName: config.timezone_name,
        timezoneOffsetHoursUtc: config.timezone_offset_hours_utc
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
 * Revela el access token completo (desencriptado) para uso interno del frontend
 * Solo se usa cuando el frontend necesita hacer llamadas a Meta API
 */
export const revealMetaToken = async (req, res) => {
  try {
    const metaConfig = await getMetaConfig();

    if (!metaConfig) {
      return res.status(404).json({
        success: false,
        error: 'No hay configuración de Meta guardada'
      });
    }

    res.json({
      success: true,
      accessToken: metaConfig.access_token // Ya viene desencriptado de getMetaConfig()
    });

  } catch (error) {
    logger.error(`Error en revealMetaToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al revelar el token de Meta'
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

const META_PREVIEW_FORMATS = [
  'DESKTOP_FEED_STANDARD',
  'MOBILE_FEED_STANDARD',
  'INSTAGRAM_STANDARD',
  'INSTAGRAM_REELS',
  'INSTAGRAM_STORY',
  'FACEBOOK_REELS_MOBILE',
  'FACEBOOK_STORY_MOBILE'
];

/**
 * Obtiene el preview renderizado por Meta para un creative.
 * El HTML de Meta suele venir como iframe/snippet y puede expirar, por eso se pide bajo demanda.
 */
export const getCreativePreview = async (req, res) => {
  try {
    const creativeId = String(req.params.creativeId || '').trim();
    const requestedFormat = String(req.query.adFormat || META_PREVIEW_FORMATS[0]).trim().toUpperCase();

    if (!/^[0-9]+$/.test(creativeId)) {
      return res.status(400).json({
        success: false,
        error: 'creativeId inválido'
      });
    }

    const metaConfig = await getMetaConfig();
    if (!metaConfig?.access_token) {
      return res.status(404).json({
        success: false,
        error: 'No hay configuración de Meta guardada'
      });
    }

    const formatsToTry = [
      META_PREVIEW_FORMATS.includes(requestedFormat) ? requestedFormat : META_PREVIEW_FORMATS[0],
      ...META_PREVIEW_FORMATS
    ].filter((format, index, formats) => formats.indexOf(format) === index);

    const errors = [];

    for (const adFormat of formatsToTry) {
      try {
        const params = new URLSearchParams({
          fields: 'body',
          ad_format: adFormat,
          access_token: metaConfig.access_token
        });
        const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(creativeId)}/previews?${params.toString()}`);
        const data = await response.json();

        if (data.error) {
          errors.push(`${adFormat}: ${data.error.message}`);
          continue;
        }

        const preview = Array.isArray(data?.data) ? data.data.find(item => item?.body) : null;
        if (preview?.body) {
          return res.json({
            success: true,
            creativeId,
            adFormat,
            body: preview.body
          });
        }
      } catch (error) {
        errors.push(`${adFormat}: ${error.message}`);
      }
    }

    logger.warn(`Meta no regresó preview para creative ${creativeId}: ${errors.join(' | ')}`);
    return res.status(404).json({
      success: false,
      error: 'Meta no regresó preview para este creative'
    });
  } catch (error) {
    logger.error(`Error en getCreativePreview: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener preview del creative'
    });
  }
};

/**
 * Inicia sincronización manual de Meta Ads desde hace 35 meses (como HighLevel)
 */
export const updateRecent = async (req, res) => {
  try {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 35);
    const startDateStr = startDate.toISOString().split('T')[0];

    logger.info(`Iniciando sincronización manual de Meta Ads (35 meses) desde: ${startDateStr}`);

    // Iniciar en background para no bloquear la respuesta HTTP
    syncMetaAds(startDateStr).catch(error => {
      logger.error(`Error en sincronización manual de Meta Ads (35 meses): ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Sincronización de Meta Ads (últimos 35 meses) iniciada exitosamente'
    });

  } catch (error) {
    logger.error(`Error en updateRecent: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar la sincronización de Meta Ads'
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

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

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

    // PASO 1: Obtener configuración de HighLevel y cargar TODOS los eventos (híbrido DB + API)
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const contactsWithAppointments = config && config.api_token
      ? await getContactsWithAppointmentsHybrid(config.location_id, config.api_token)
      : new Set();

    logger.info(`📊 ${contactsWithAppointments.size} contactos con citas (híbrido DB + API - Campaigns)`);

    // PASO 2: Obtener métricas básicas de contactos CON validación de match en meta_ads
    // IMPORTANTE: Solo contar contactos cuyo attribution_ad_id tenga registro en meta_ads en la misma fecha
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    const contactsQuery = `
      SELECT
        c.attribution_ad_id as ad_id,
        c.id as contact_id,
        c.purchases_count,
        c.total_paid
      FROM contacts c
      WHERE c.attribution_ad_id IS NOT NULL
      AND c.created_at >= ?
      AND c.created_at <= ?
      AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND DATE(ma.date) = DATE(c.created_at)
      )
      ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    `;

    const contactsRaw = await db.all(contactsQuery, [
      range.startUtc,
      range.endUtc
    ]);

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

    // Obtener todos los ad_ids que tienen contactos en el período
    const adIdsWithContacts = contactsData.map(row => row.ad_id).filter(Boolean);

    // Query para obtener datos agregados por campaña, adset y ad
    // SOLO incluir gasto del período (sin OR que incluya fechas fuera del rango)
    const aggregationQuery = `
      SELECT DISTINCT
        m.campaign_id, m.campaign_name,
        m.adset_id, m.adset_name,
        m.ad_id, m.ad_name,
        MAX(m.creative_id) as creative_id,
        MAX(m.creative_type) as creative_type,
        MAX(m.creative_thumbnail_url) as creative_thumbnail_url,
        MAX(m.creative_image_url) as creative_image_url,
        MAX(m.creative_video_id) as creative_video_id,
        MAX(m.creative_video_url) as creative_video_url,
        MAX(m.creative_preview_url) as creative_preview_url,
        COALESCE(SUM(m.spend), 0) as spend,
        COALESCE(SUM(m.reach), 0) as reach,
        COALESCE(SUM(m.clicks), 0) as clicks,
        AVG(m.cpc) as cpc,
        AVG(m.cpm) as cpm
      FROM meta_ads m
      WHERE m.date BETWEEN $1 AND $2
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
          visitors: 0,
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
          visitors: 0,
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
        creativeId: row.creative_id || null,
        creativeType: row.creative_type || null,
        creativeThumbnailUrl: row.creative_thumbnail_url || null,
        creativeImageUrl: row.creative_image_url || null,
        creativeVideoId: row.creative_video_id || null,
        creativeVideoUrl: row.creative_video_url || null,
        creativePreviewUrl: row.creative_preview_url || null,
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

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const start = range.startZoned.toISODate();
    const end = range.endZoned.toISODate();

    logger.info(`Obteniendo gastos e ingresos desde ${start} hasta ${end}`);

    // Query de gastos (PostgreSQL)
    const spendQuery = `
      SELECT
        TO_CHAR(date::date, 'YYYY-MM-DD') as day,
        SUM(spend) as spend
      FROM meta_ads
      WHERE date::date >= $1::date AND date::date < ($2::date + INTERVAL '1 day')
      GROUP BY day
      ORDER BY day ASC
    `;
    const spendParams = [start, end];

    // Query de ingresos ATRIBUIDOS basado en fecha de CREACIÓN del contacto y su LTV total
    // Usamos la fecha cuando el contacto llegó (created_at) y sumamos su valor total acumulado (total_paid)
    // VALIDACIÓN: Solo cuenta si el anuncio EXISTIÓ en Meta ese mismo día
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    const revenueQuery = `
      SELECT
        TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
        SUM(c.total_paid) as revenue
      FROM contacts c
      WHERE c.attribution_ad_id IS NOT NULL
        AND c.attribution_ad_id != ''
        AND c.created_at::date >= $1::date
        AND c.created_at::date < ($2::date + INTERVAL '1 day')
        AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = c.attribution_ad_id
            AND ma.date::date = c.created_at::date
        )
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
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

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

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
    // IMPORTANTE: Filtrar por rango de fechas para que coincida con los números de la tabla
    if (ad_id) {
      // Si se especifica un ad_id directamente, usarlo
      adIdsList = [ad_id];
    } else if (adset_id) {
      // Obtener ads del adset que tienen actividad en el rango de fechas
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE adset_id = $1
        AND date >= $2
        AND date <= $3
      `;
      const adIds = await db.all(adIdsQuery, [adset_id, range.startUtc, range.endUtc]);
      adIdsList = adIds.map(row => row.ad_id);
    } else if (campaign_id) {
      // Obtener ads de la campaña que tienen actividad en el rango de fechas
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE campaign_id = $1
        AND date >= $2
        AND date <= $3
      `;
      const adIds = await db.all(adIdsQuery, [campaign_id, range.startUtc, range.endUtc]);
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

    // Construir query de contactos (sin JOIN de appointments, ahora usamos método optimizado)
    // IMPORTANTE: Validar que attribution_ad_id exista en meta_ads con fecha coincidente
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    const placeholders = adIdsList.map(() => '?').join(',');
    let contactsQuery = `
      SELECT DISTINCT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        c.attribution_ad_id,
        c.attribution_ad_name,
        c.total_paid,
        c.purchases_count,
        c.created_at,
        ma.campaign_name,
        ma.adset_name,
        ma.ad_name
      FROM contacts c
      LEFT JOIN meta_ads ma ON ma.ad_id = c.attribution_ad_id AND ma.date::date = c.created_at::date
      WHERE c.attribution_ad_id IN (${placeholders})
      AND c.created_at >= ?
      AND c.created_at <= ?
      AND EXISTS (
        SELECT 1 FROM meta_ads ma2
        WHERE ma2.ad_id = c.attribution_ad_id
          AND ma2.date::date = c.created_at::date
      )
      ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    `;

    if (type === 'sales') {
      contactsQuery += ' AND purchases_count > 0';
    }

    contactsQuery += ' ORDER BY c.created_at DESC';

    const contactsParams = [...adIdsList, range.startUtc, range.endUtc];
    let contacts = await db.all(contactsQuery, contactsParams);

    // Si type === 'appointments', filtrar usando híbrido DB + API
    if (type === 'appointments') {
      const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
      const contactsWithAppointments = config && config.api_token
        ? await getContactsWithAppointmentsHybrid(config.location_id, config.api_token)
        : new Set();

      logger.info(`📊 Filtrando ${contacts.length} contactos por citas (${contactsWithAppointments.size} con citas - híbrido DB + API)`);

      // Filtrar solo contactos con citas
      contacts = contacts.filter(c => contactsWithAppointments.has(c.id));
    }

    const contactIds = contacts.map(contact => contact.id).filter(Boolean);

    let paymentsMap = new Map();
    let appointmentsMap = new Map();
    let firstSessionMap = new Map();

    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => '?').join(',');

      // IMPORTANTE: NO filtrar pagos por rango de fechas
      // El modal debe mostrar TODOS los pagos del cliente, independientemente del rango seleccionado
      // El filtro de fechas solo aplica para determinar QUÉ contactos mostrar, no sus pagos completos
      const paymentsQuery = `
        SELECT
          id,
          contact_id,
          amount,
          status,
          date
        FROM payments
        WHERE contact_id IN (${placeholders})
        ORDER BY date DESC
      `;

      const paymentRows = await db.all(paymentsQuery, contactIds);

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

      // Obtener TODAS las citas de estos contactos (sin filtrar por rango de fechas)
      const appointmentsQuery = `
        SELECT
          id,
          contact_id,
          title,
          start_time,
          end_time,
          status
        FROM appointments
        WHERE contact_id IN (${placeholders})
        ORDER BY start_time DESC
      `;

      const appointmentRows = await db.all(appointmentsQuery, contactIds);

      appointmentsMap = appointmentRows.reduce((map, appointment) => {
        const list = map.get(appointment.contact_id) || [];
        list.push({
          id: appointment.id,
          title: appointment.title,
          start_time: appointment.start_time,
          end_time: appointment.end_time,
          status: appointment.status
        });
        map.set(appointment.contact_id, list);
        return map;
      }, new Map());

      // Obtener primera sesión (primera atribución) de cada contacto
      const firstSessionsQuery = `
        SELECT
          s1.contact_id,
          s1.started_at,
          s1.page_url,
          s1.referrer_url,
          s1.utm_source,
          s1.utm_medium,
          s1.utm_campaign,
          s1.utm_content,
          s1.utm_term,
          s1.source_platform,
          s1.site_source_name,
          s1.campaign_name,
          s1.ad_name,
          s1.ad_id,
          s1.device_type,
          s1.browser,
          s1.geo_city,
          s1.geo_region,
          s1.geo_country
        FROM sessions s1
        INNER JOIN (
          SELECT contact_id, MIN(started_at) as first_started_at
          FROM sessions
          WHERE contact_id IN (${placeholders})
          GROUP BY contact_id
        ) s2 ON s1.contact_id = s2.contact_id AND s1.started_at = s2.first_started_at
      `;

      const firstSessionRows = await db.all(firstSessionsQuery, contactIds);

      firstSessionMap = firstSessionRows.reduce((map, session) => {
        map.set(session.contact_id, {
          started_at: session.started_at,
          page_url: session.page_url,
          referrer_url: session.referrer_url,
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          utm_content: session.utm_content,
          utm_term: session.utm_term,
          source_platform: session.source_platform,
          site_source_name: session.site_source_name,
          campaign_name: session.campaign_name,
          ad_name: session.ad_name,
          ad_id: session.ad_id,
          device_type: session.device_type,
          browser: session.browser,
          geo_city: session.geo_city,
          geo_region: session.geo_region,
          geo_country: session.geo_country
        });
        return map;
      }, new Map());
    }

    const mappedContacts = contacts.map(contact => {
      const payments = paymentsMap.get(contact.id) || [];
      const appointments = appointmentsMap.get(contact.id) || [];
      const firstSession = firstSessionMap.get(contact.id) || null;
      // CRÍTICO: Solo sumar pagos exitosos, NO incluir refunded/cancelled
      const validStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'];
      const totalFromPayments = payments
        .filter(payment => validStatuses.includes(payment.status?.toLowerCase()))
        .reduce((sum, payment) => sum + payment.amount, 0);
      const totalPaid = contact.total_paid ? Number(contact.total_paid) : totalFromPayments;

      return {
        id: contact.id,
        name: contact.full_name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        created_at: contact.created_at,
        ltv: totalPaid,
        ad_id: contact.attribution_ad_id,
        ad_name: contact.ad_name || contact.attribution_ad_name,
        campaign_name: contact.campaign_name,
        adset_name: contact.adset_name,
        is_sale: contact.purchases_count > 0,
        payments: payments,
        appointments: appointments,
        firstSession: firstSession
      };
    });

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

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = `SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT id) as leads
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND created_at::date >= $1::date
         AND created_at::date < ($2::date + INTERVAL '1 day')
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
       GROUP BY day
       ORDER BY day`;

    // Query para obtener contactos únicos con citas por fecha de creación
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map((_, i) => `$${i + 3}`).join(',');
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           AND a.calendar_id IN (${calendarPlaceholders})
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
    }

    const params = [startUtc, endUtc];
    const [leadsData, appointmentsData] = await Promise.all([
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, appointmentsParams)
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

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    // Query para obtener contactos únicos con citas por fecha de creación
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map((_, i) => `$${i + 3}`).join(',');
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           AND a.calendar_id IN (${calendarPlaceholders})
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
    }

    // Query para obtener ventas (contactos con purchases_count > 0) por fecha de creación
    const salesQuery = `SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT id) as sales
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND purchases_count > 0
         AND created_at::date >= $1::date
         AND created_at::date < ($2::date + INTERVAL '1 day')
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
       GROUP BY day
       ORDER BY day`;

    const params = [startUtc, endUtc];
    const [appointmentsData, salesData] = await Promise.all([
      db.all(appointmentsQuery, appointmentsParams),
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

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    // Query para obtener visitantes únicos por fecha desde sessions
    const visitorsQuery = `SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT visitor_id) as visitors
       FROM sessions
       WHERE ad_id IS NOT NULL
         AND ad_id != ''
         AND created_at::date >= $1::date
         AND created_at::date < ($2::date + INTERVAL '1 day')
       GROUP BY day
       ORDER BY day`;

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = `SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT id) as leads
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND created_at::date >= $1::date
         AND created_at::date < ($2::date + INTERVAL '1 day')
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
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

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Query para visitantes únicos CON ad_id (columna correcta en sessions)
    const visitorsQuery = `SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT visitor_id) as visitors
       FROM sessions
       WHERE ad_id IS NOT NULL
         AND ad_id != ''
         AND created_at::date >= $1::date
         AND created_at::date < ($2::date + INTERVAL '1 day')
       GROUP BY day`;

    // Query para leads CON attribution_ad_id validando que el anuncio existiera ese día en Meta
    const leadsQuery = `SELECT
        TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT c.id) as leads
       FROM contacts c
       WHERE c.attribution_ad_id IS NOT NULL
         AND c.attribution_ad_id != ''
         AND c.created_at::date >= $1::date
         AND c.created_at::date < ($2::date + INTERVAL '1 day')
         AND EXISTS (
           SELECT 1 FROM meta_ads ma
           WHERE ma.ad_id = c.attribution_ad_id
             AND ma.date::date = c.created_at::date
         )
         ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
       GROUP BY day`;

    // Query para contactos con citas CON attribution_ad_id validando que el anuncio existiera ese día
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map((_, i) => `$${i + 3}`).join(',');
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           AND a.calendar_id IN (${calendarPlaceholders})
           AND EXISTS (
             SELECT 1 FROM meta_ads ma
             WHERE ma.ad_id = c.attribution_ad_id
               AND ma.date::date = c.created_at::date
           )
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
          COUNT(DISTINCT c.id) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND c.created_at::date >= $1::date
           AND c.created_at::date < ($2::date + INTERVAL '1 day')
           AND EXISTS (
             SELECT 1 FROM meta_ads ma
             WHERE ma.ad_id = c.attribution_ad_id
               AND ma.date::date = c.created_at::date
           )
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day`;
    }

    // Query para ventas CON attribution_ad_id validando que el anuncio existiera ese día
    const salesQuery = `SELECT
        TO_CHAR(c.created_at::date, 'YYYY-MM-DD') as day,
        COUNT(DISTINCT c.id) as sales
       FROM contacts c
       WHERE c.attribution_ad_id IS NOT NULL
         AND c.attribution_ad_id != ''
         AND c.purchases_count > 0
         AND c.created_at::date >= $1::date
         AND c.created_at::date < ($2::date + INTERVAL '1 day')
         AND EXISTS (
           SELECT 1 FROM meta_ads ma
           WHERE ma.ad_id = c.attribution_ad_id
             AND ma.date::date = c.created_at::date
         )
         ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
       GROUP BY day`;

    const params = [startUtc, endUtc];
    const [visitorsData, leadsData, appointmentsData, salesData] = await Promise.all([
      db.all(visitorsQuery, params),
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, appointmentsParams),
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

    // Generar TODAS las fechas del rango (incluso las que no tienen datos)
    const allDates = [];
    let currentDate = new Date(startUtc);
    const endDateObj = new Date(endUtc);

    while (currentDate <= endDateObj) {
      const dateStr = currentDate.toISOString().split('T')[0];
      allDates.push(dateStr);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Mapear al formato esperado con todas las métricas
    const mappedData = allDates.map(date => ({
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

/**
 * Obtiene los Custom Values de Meta desde HighLevel
 */
export const getMetaCustomValues = async (req, res) => {
  try {
    logger.info('Obteniendo custom values de Meta desde HighLevel...');

    // 1. Obtener configuración de HighLevel
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    if (!hlConfig || !hlConfig.location_id || !hlConfig.api_token) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel. Primero debes conectar HighLevel en Settings.'
      });
    }

    // 2. Buscar custom values de Meta en HighLevel
    const metaCustomValues = await fetchAndSaveMetaConfig(hlConfig.location_id, hlConfig.api_token);

    if (!metaCustomValues) {
      return res.json({
        success: true,
        data: {
          adAccountId: '',
          accessToken: '',
          pixelId: '',
          pageId: '',
          pixelApiToken: ''
        }
      });
    }

    res.json({
      success: true,
      data: metaCustomValues
    });

  } catch (error) {
    logger.error(`Error en getMetaCustomValues: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener custom values de Meta desde HighLevel'
    });
  }
};

/**
 * Guarda credenciales de Meta en HighLevel y luego sincroniza
 * USA System User Token (no requiere App ID ni App Secret)
 */
export const saveAndSyncMeta = async (req, res) => {
  try {
    const { adAccountId, accessToken, pixelId, pageId, pixelApiToken } = req.body;

    logger.info('Guardando credenciales de Meta en HighLevel...');

    // 1. Validar que al menos tengamos ad_account_id y access_token
    if (!adAccountId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren al menos Ad Account ID y Access Token'
      });
    }

    // 2. Obtener configuración de HighLevel
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    if (!hlConfig || !hlConfig.location_id || !hlConfig.api_token) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel. Primero debes conectar HighLevel en Settings.'
      });
    }

    // 3. Importar función de guardado
    const { saveMetaCustomValues } = await import('../services/highlevelSyncService.js');

    // 4. Guardar en HighLevel Custom Values (System User - solo necesita Access Token + Ad Account + Pixel + Page ID + Pixel API Token)
    const saveResult = await saveMetaCustomValues(hlConfig.location_id, hlConfig.api_token, {
      adAccountId,
      accessToken,
      pixelId: pixelId || '',
      pageId: pageId || '',
      pixelApiToken: pixelApiToken || ''
    });

    if (!saveResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Error al guardar credenciales en HighLevel'
      });
    }

    logger.info('Credenciales guardadas en HighLevel exitosamente');

    // 5. Guardar en meta_config local (encriptado)
    await saveMetaConfig(
      adAccountId,
      accessToken,
      pixelId || null,
      pixelApiToken || null,
      pageId || null
    );

    logger.info('Credenciales guardadas en base de datos local');

    // 6. Validar que las credenciales funcionen
    logger.info('Validando credenciales de Meta...');
    const validation = await verifyMetaToken(accessToken);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Credenciales de Meta inválidas: ${validation.error || 'Token inválido o expirado'}`
      });
    }

    logger.info('Credenciales de Meta validadas exitosamente');

    // 7. Iniciar sincronización de anuncios (últimos 7 días)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const startDateStr = startDate.toISOString().split('T')[0];

    logger.info(`Iniciando sincronización de anuncios desde: ${startDateStr}`);

    // No esperar a que termine la sincronización (es async)
    syncMetaAds(startDateStr).catch(error => {
      logger.error(`Error en sincronización de Meta Ads: ${error.message}`);
    });

    // 8. Si tenemos dominio personalizado (NO estamos en .onrender.com), sincronizar snippet automáticamente
    const isRenderDomain = req.headers.host?.includes('onrender.com')
    if (!isRenderDomain && req.headers.host && pixelId) {
      // Leer preferencia del usuario: ¿quiere incluir Meta Pixel en el snippet?
      // Default: true (ON por default)
      const { getAppConfig } = await import('../config/database.js')
      const includeMetaPixelPref = await getAppConfig('include_meta_pixel')
      const includeMetaPixel = includeMetaPixelPref === null || includeMetaPixelPref === undefined
        ? true // Default: ON
        : (includeMetaPixelPref === '1' || includeMetaPixelPref === 1 || includeMetaPixelPref === true || includeMetaPixelPref === 'true')

      if (includeMetaPixel) {
        logger.info(`Dominio personalizado detectado (${req.headers.host}), sincronizando snippet con Meta Pixel ${pixelId}...`)

        // Importar la función de configuración de tracking
        const { configureTracking } = await import('./trackingController.js')

        // Crear un objeto de respuesta temporal (no queremos esperar ni que falle si hay error)
        const tempRes = {
          json: (data) => {
            if (data.success) {
              logger.info('✅ Snippet sincronizado automáticamente con Meta Pixel incluido')
            } else {
              logger.warn(`⚠️ No se pudo sincronizar snippet: ${data.error || 'unknown'}`)
            }
          },
          status: (code) => {
            if (code !== 200) {
              logger.warn(`⚠️ Sincronización de snippet retornó status ${code}`)
            }
            return tempRes
          }
        }

        // Ejecutar en background (no bloquear la respuesta)
        configureTracking(req, tempRes).catch(err => {
          logger.warn(`⚠️ Error sincronizando snippet automáticamente: ${err.message}`)
        })
      } else {
        logger.info(`Usuario configuró Meta Pixel (${pixelId}) pero tiene DESACTIVADA la inclusión en snippet (include_meta_pixel = false)`)
        logger.info('NO se auto-sincronizará el snippet. El usuario puede activar el switch en Settings → Meta Ads')
      }
    } else if (isRenderDomain) {
      logger.info('Dominio .onrender.com detectado, NO sincronizando snippet (requiere dominio personalizado)')
    } else if (!pixelId) {
      logger.info('No se proporcionó Pixel ID, snippet NO incluirá Meta Pixel')
    }

    res.json({
      success: true,
      message: 'Credenciales guardadas y sincronización iniciada exitosamente',
      data: {
        savedInHighLevel: saveResult.success,
        adAccountId: adAccountId,
        tokenValid: validation.valid,
        syncStarted: true
      }
    });

  } catch (error) {
    logger.error(`Error en saveAndSyncMeta: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar y sincronizar credenciales de Meta'
    });
  }
};

/**
 * Sincroniza configuración de Meta desde HighLevel custom values
 * Busca los custom values de Meta en HighLevel, los guarda en meta_config,
 * valida que funcionen y luego inicia sincronización de anuncios
 */
export const syncFromHighLevel = async (req, res) => {
  try {
    logger.info('Iniciando sincronización de Meta desde HighLevel custom values...');

    // 1. Obtener configuración de HighLevel
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    if (!hlConfig || !hlConfig.location_id || !hlConfig.api_token) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de HighLevel. Primero debes conectar HighLevel en Settings.'
      });
    }

    // 2. Buscar custom values de Meta en HighLevel
    logger.info('Buscando custom values de Meta en HighLevel...');
    const metaCustomValues = await fetchAndSaveMetaConfig(hlConfig.location_id, hlConfig.api_token);

    if (!metaCustomValues || !metaCustomValues.adAccountId || !metaCustomValues.accessToken.startsWith('***')) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron custom values de Meta en HighLevel. Verifica que hayas creado los custom values con los nombres exactos.'
      });
    }

    // 3. Guardar en base de datos local (necesitamos tokens SIN enmascarar)
    // Volver a obtener los valores SIN enmascarar desde HighLevel
    const response = await fetch(
      `https://services.leadconnectorhq.com/locations/${hlConfig.location_id}/customValues`,
      {
        headers: {
          'Authorization': `Bearer ${hlConfig.api_token}`,
          'Version': '2021-07-28'
        }
      }
    );

    const data = await response.json();
    const customValues = data.customValues || [];

    const fbAdAccountId = customValues.find(cv => cv.name === 'Facebook - Ad Account ID')?.value;
    const fbAccessToken = customValues.find(cv => cv.name === 'Facebook - App Access Token')?.value;
    const fbPixelId = customValues.find(cv => cv.name === 'Facebook - Pixel ID')?.value;
    const fbPageId = customValues.find(cv => cv.name === 'Facebook - Page ID')?.value;
    const fbPixelApiToken = customValues.find(cv => cv.name === 'Facebook - Pixel API Token')?.value;

    // Guardar en DB local (tokens SIN enmascarar)
    if (fbAdAccountId && fbAccessToken) {
      await saveMetaConfig(
        fbAdAccountId,
        fbAccessToken,
        fbPixelId || null,
        fbPixelApiToken || null,
        fbPageId || null
      );
      logger.info('Credenciales de Meta guardadas en base de datos local');
    }

    // 4. Verificar si se guardaron las credenciales
    const metaConfig = await getMetaConfig();

    if (!metaConfig || !metaConfig.access_token || !metaConfig.ad_account_id) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron custom values de Meta en HighLevel. Verifica que hayas creado los 4 custom values con los nombres exactos.'
      });
    }

    logger.info('Credenciales de Meta encontradas y guardadas exitosamente');

    // 4. Validar que las credenciales funcionen
    logger.info('Validando credenciales de Meta...');
    const validation = await verifyMetaToken(metaConfig.access_token);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Credenciales de Meta inválidas: ${validation.error || 'Token inválido o expirado'}`
      });
    }

    logger.info('Credenciales de Meta validadas exitosamente');

    // 5. Iniciar sincronización de anuncios (últimos 7 días)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const startDateStr = startDate.toISOString().split('T')[0];

    logger.info(`Iniciando sincronización de anuncios desde: ${startDateStr}`);

    // No esperar a que termine la sincronización (es async)
    syncMetaAds(startDateStr).catch(error => {
      logger.error(`Error en sincronización de Meta Ads: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Configuración de Meta sincronizada exitosamente. Sincronización de anuncios iniciada.',
      data: {
        adAccountId: metaConfig.ad_account_id,
        tokenValid: validation.valid,
        syncStarted: true
      }
    });

  } catch (error) {
    logger.error(`Error en syncFromHighLevel: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al sincronizar configuración de Meta desde HighLevel'
    });
  }
};

/**
 * Obtiene las cuentas de anuncios del usuario de Meta
 * GET /api/meta/ad-accounts?accessToken=xxx
 */
export const getAdAccounts = async (req, res) => {
  try {
    const { accessToken } = req.query;

    if (!accessToken) {
      logger.error('❌ No se proporcionó accessToken');
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    logger.info('Obteniendo cuentas de Meta Ads');

    // VERIFICAR VERSIÓN ACTUAL EN MEMORIA
    const { getMetaApiVersion } = await import('../config/constants.js');
    const currentVersion = getMetaApiVersion();

    // FORZAR v23.0 SI ES NECESARIO
    if (currentVersion !== 'v23.0') {
      logger.warn(`Versión incorrecta detectada: ${currentVersion}, forzando v23.0`);
      const { setMetaApiVersion } = await import('../config/constants.js');
      setMetaApiVersion('v23.0');
    }

    // PASO 1: Verificar token y obtener user_id
    const debugUrl = `https://graph.facebook.com/v23.0/debug_token?input_token=${accessToken}&access_token=${accessToken}`;

    const debugResponse = await fetch(debugUrl);
    const debugData = await debugResponse.json();

    if (debugData.error) {
      logger.error('Error verificando token:', debugData.error);
      return res.status(400).json({
        success: false,
        error: debugData.error.message || 'Token inválido'
      });
    }

    const userId = debugData.data?.user_id;

    if (!userId) {
      logger.error('No se pudo extraer user_id del token');
      return res.status(400).json({
        success: false,
        error: 'No se pudo obtener user_id del token'
      });
    }

    // PASO 2: Obtener ad accounts DIRECTAMENTE del System User (sin businesses)
    const adAccountsUrl = `https://graph.facebook.com/v23.0/${userId}/adaccounts?fields=id,account_id,name,currency,timezone_name,account_status&access_token=${accessToken}`;

    const adAccountsResponse = await fetch(adAccountsUrl);
    const adAccountsData = await adAccountsResponse.json();

    if (adAccountsData.error) {
      logger.error('Error obteniendo ad accounts:', adAccountsData.error);
      return res.status(400).json({
        success: false,
        error: adAccountsData.error.message || 'Error obteniendo cuentas de anuncios'
      });
    }

    const uniqueAccounts = adAccountsData.data || [];
    logger.info(`Encontradas ${uniqueAccounts.length} cuenta(s) de anuncios`);

    res.json({
      success: true,
      data: {
        adAccounts: uniqueAccounts
      }
    });

  } catch (error) {
    logger.error(`Error en getAdAccounts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener cuentas de anuncios'
    });
  }
};

/**
 * Obtiene los pixeles de Meta de una cuenta de anuncios
 * GET /api/meta/pixels?adAccountId=act_123&accessToken=xxx
 */
export const getPixels = async (req, res) => {
  try {
    const { adAccountId, accessToken } = req.query;

    if (!adAccountId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren adAccountId y accessToken'
      });
    }

    logger.info(`Obteniendo pixeles para cuenta: ${adAccountId}`);

    // Llamar a Meta Graph API para obtener pixels
    const url = `${API_URLS.META_GRAPH}/${adAccountId}/adspixels?fields=id,name,code,creation_time,last_fired_time&access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      logger.error('Error de Meta API:', data.error.message);
      return res.status(400).json({
        success: false,
        error: data.error.message || 'Error obteniendo pixeles'
      });
    }

    const pixels = data.data || [];
    logger.info(`✅ Encontrados ${pixels.length} pixeles`);

    res.json({
      success: true,
      data: {
        pixels: pixels
      }
    });

  } catch (error) {
    logger.error(`Error en getPixels: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener pixeles'
    });
  }
};

/**
 * Guarda SOLO el Pixel API Token en la base de datos y en HighLevel Custom Values
 * POST /api/meta/save-pixel-token
 * Body: { pixelApiToken: 'xxx' }
 */
export const savePixelToken = async (req, res) => {
  try {
    const { pixelApiToken } = req.body;

    if (!pixelApiToken || pixelApiToken.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Se requiere pixelApiToken'
      });
    }

    logger.info('Guardando Pixel API Token');

    // 1. Verificar que exista configuración de Meta
    const metaConfig = await getMetaConfig();

    if (!metaConfig || !metaConfig.ad_account_id) {
      return res.status(400).json({
        success: false,
        error: 'No hay configuración de Meta. Primero debes guardar Access Token y Ad Account.'
      });
    }

    // 2. Primero actualizar en HighLevel Custom Values (si está configurado)
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    if (hlConfig && hlConfig.location_id && hlConfig.api_token) {

      try {
        const { saveMetaCustomValues } = await import('../services/highlevelSyncService.js');

        const credentialsToSave = {
          adAccountId: metaConfig.ad_account_id,
          accessToken: metaConfig.access_token,
          pixelId: metaConfig.pixel_id || '',
          pageId: metaConfig.page_id || '',
          pixelApiToken: pixelApiToken // Token fresco del request body
        };

        logger.info('Credenciales a guardar en HighLevel:');
        logger.info(`  - adAccountId: ${credentialsToSave.adAccountId}`);
        logger.info(`  - accessToken: ${credentialsToSave.accessToken ? 'presente (encriptado)' : 'VACÍO'}`);
        logger.info(`  - pixelId: ${credentialsToSave.pixelId || 'vacío'}`);
        logger.info(`  - pageId: ${credentialsToSave.pageId || 'vacío'}`);
        logger.info(`  - pixelApiToken: ${credentialsToSave.pixelApiToken.substring(0, 20)}...`);

        // Pasar DIRECTAMENTE el pixelApiToken del request (no del metaConfig)
        const result = await saveMetaCustomValues(hlConfig.location_id, hlConfig.api_token, credentialsToSave);

        logger.info('Resultado de saveMetaCustomValues:', JSON.stringify(result, null, 2));
        logger.info('✅ Pixel API Token actualizado en HighLevel Custom Values');
      } catch (hlError) {
        logger.error(`❌ Error actualizando Pixel API Token en HighLevel: ${hlError.message}`);
        logger.error('Stack:', hlError.stack);
        // No fallar si HighLevel falla, continuar con DB
      }
    } else {
      logger.warn('⚠️ HighLevel NO configurado. Saltando actualización de custom values.');
    }

    // 3. Actualizar en meta_config local
    await saveMetaConfig(
      metaConfig.ad_account_id,
      metaConfig.access_token, // Mantener el access_token existente
      metaConfig.pixel_id || null,
      pixelApiToken, // Actualizar solo este campo
      metaConfig.page_id || null
    );

    logger.info('Pixel API Token guardado en base de datos local');

    res.json({
      success: true,
      message: 'Pixel API Token guardado exitosamente'
    });

  } catch (error) {
    logger.error(`Error en savePixelToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar Pixel API Token'
    });
  }
};
