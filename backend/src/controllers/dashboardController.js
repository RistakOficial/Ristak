import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { resolveDateRange } from '../utils/dateUtils.js';
import { normalizeTrafficSource } from '../utils/trafficSourceNormalizer.js';
import { DateTime } from 'luxon';
import { getContactsWithAppointmentsHybrid } from '../services/appointmentsMerge.js';

const calculateDelta = (current, previous) => {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(delta) ? delta : 0;
};

const buildDateFilters = (range) => {
  const filters = [];
  const params = [];

  if (range.startUtc) {
    filters.push('date >= ?');
    params.push(range.startUtc);
  }

  if (range.endUtc) {
    filters.push('date <= ?');
    params.push(range.endUtc);
  }

  return { filters, params };
};

const buildContactFilters = (range) => {
  const filters = ['total_paid > 0'];
  const params = [];

  if (range.startUtc) {
    filters.push('created_at >= ?');
    params.push(range.startUtc);
  }

  if (range.endUtc) {
    filters.push('created_at <= ?');
    params.push(range.endUtc);
  }

  return { filters, params };
};

const computeFinancialSnapshot = async (range) => {
  const paymentsFilters = ['status = ?'];
  const paymentsParams = ['succeeded'];
  const { filters: dateFilters, params: dateParams } = buildDateFilters(range);
  paymentsFilters.push(...dateFilters);
  paymentsParams.push(...dateParams);

  const ingresosQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE ${paymentsFilters.join(' AND ')}`;
  const ingresosRow = await db.get(ingresosQuery, paymentsParams);
  const ingresosNetos = parseFloat(ingresosRow?.total || 0);

  const gastosFilters = [];
  const gastosParams = [];
  const { filters: spendDateFilters, params: spendDateParams } = buildDateFilters(range);
  if (spendDateFilters.length) {
    gastosFilters.push(...spendDateFilters);
    gastosParams.push(...spendDateParams);
  }

  const gastosWhere = gastosFilters.length ? `WHERE ${gastosFilters.join(' AND ')}` : '';
  const gastosQuery = `SELECT COALESCE(SUM(spend), 0) as total FROM meta_ads ${gastosWhere}`;
  const gastosRow = await db.get(gastosQuery, gastosParams);
  const gastosPublicidad = parseFloat(gastosRow?.total || 0);

  const refundsFilters = ['status = ?'];
  const refundsParams = ['refunded'];
  const { filters: refundDateFilters, params: refundDateParams } = buildDateFilters(range);
  refundsFilters.push(...refundDateFilters);
  refundsParams.push(...refundDateParams);

  const refundsQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE ${refundsFilters.join(' AND ')}`;
  const refundsRow = await db.get(refundsQuery, refundsParams);
  const reembolsos = parseFloat(refundsRow?.total || 0);

  const { filters: contactFilters, params: contactParams } = buildContactFilters(range);
  const contactsWhere = contactFilters.length ? `WHERE ${contactFilters.join(' AND ')}` : '';
  const ltvQuery = `SELECT COALESCE(AVG(total_paid), 0) as avg_ltv FROM contacts ${contactsWhere}`;
  const ltvRow = await db.get(ltvQuery, contactParams);
  const ltvPromedio = parseFloat(ltvRow?.avg_ltv || 0);

  const gananciaBruta = ingresosNetos - gastosPublicidad;
  const iva = ingresosNetos * 0.16;
  const gananciaNeta = gananciaBruta - iva;
  const roas = gastosPublicidad > 0 ? ingresosNetos / gastosPublicidad : 0;

  return {
    ingresosNetos,
    gastosPublicidad,
    gananciaBruta,
    roas,
    ivaPagar: iva,
    gananciaNeta,
    reembolsos,
    ltvPromedio
  };
};

/**
 * Calcula y devuelve los KPIs principales del dashboard
 */
export const getMetrics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate (formato: YYYY-MM-DD)'
      });
    }

    logger.info(`Calculando métricas del dashboard desde ${startDate} hasta ${endDate}`);

    const range = resolveDateRange({ startDate, endDate });

    const spanDays = range.startZoned && range.endZoned
      ? Math.max(Math.round(range.endZoned.diff(range.startZoned, 'days').days) + 1, 1)
      : null;

    let previousRange = null;

    if (spanDays) {
      const prevEnd = range.startZoned.minus({ days: 1 }).endOf('day');
      const prevStart = prevEnd.minus({ days: spanDays - 1 }).startOf('day');
      previousRange = {
        startUtc: prevStart.toUTC().toISO({ suppressMilliseconds: false }),
        endUtc: prevEnd.toUTC().toISO({ suppressMilliseconds: false })
      };
    } else {
      const zone = range.appliedTimezone;
      const nowZoned = DateTime.now().setZone(zone);
      const currentMonthStart = nowZoned.startOf('month');
      const previousMonthStart = currentMonthStart.minus({ months: 1 }).startOf('month');
      const previousMonthEnd = currentMonthStart.minus({ days: 1 }).endOf('day');
      previousRange = {
        startUtc: previousMonthStart.toUTC().toISO({ suppressMilliseconds: false }),
        endUtc: previousMonthEnd.toUTC().toISO({ suppressMilliseconds: false })
      };
    }

    const currentSnapshot = await computeFinancialSnapshot(range);
    const previousSnapshot = await computeFinancialSnapshot(previousRange);

    const metrics = {
      ingresosNetos: {
        value: parseFloat(currentSnapshot.ingresosNetos.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.ingresosNetos, previousSnapshot.ingresosNetos).toFixed(2))
      },
      gastosPublicidad: {
        value: parseFloat(currentSnapshot.gastosPublicidad.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.gastosPublicidad, previousSnapshot.gastosPublicidad).toFixed(2))
      },
      gananciaBruta: {
        value: parseFloat(currentSnapshot.gananciaBruta.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.gananciaBruta, previousSnapshot.gananciaBruta).toFixed(2))
      },
      roas: {
        value: parseFloat(currentSnapshot.roas.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.roas, previousSnapshot.roas).toFixed(2))
      },
      ivaPagar: {
        value: parseFloat(currentSnapshot.ivaPagar.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.ivaPagar, previousSnapshot.ivaPagar).toFixed(2))
      },
      gananciaNeta: {
        value: parseFloat(currentSnapshot.gananciaNeta.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.gananciaNeta, previousSnapshot.gananciaNeta).toFixed(2))
      },
      reembolsos: {
        value: parseFloat(currentSnapshot.reembolsos.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.reembolsos, previousSnapshot.reembolsos).toFixed(2))
      },
      ltvPromedio: {
        value: parseFloat(currentSnapshot.ltvPromedio.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.ltvPromedio, previousSnapshot.ltvPromedio).toFixed(2))
      }
    };

    logger.info(`Métricas calculadas: ROAS ${metrics.roas.value}, Ganancia Neta ${metrics.gananciaNeta.value}`);

    res.json(metrics);

  } catch (error) {
    logger.error(`Error en getMetrics: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al calcular las métricas'
    });
  }
};

/**
 * Obtiene datos para gráficas (ingresos, gastos, ROAS por periodo)
 */
export const getChartData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate (formato: YYYY-MM-DD)'
      });
    }

    if (!['day', 'month'].includes(groupBy)) {
      return res.status(400).json({
        success: false,
        error: 'groupBy debe ser "day" o "month"'
      });
    }

    logger.info(`Obteniendo datos de gráficas agrupados por ${groupBy}`);

    // Determinar formato de fecha según el agrupamiento y la base de datos
    let ingresosQuery, gastosQuery;
    let ingresosParams, gastosParams;

    const usePostgres = Boolean(process.env.DATABASE_URL);

    if (usePostgres) {
      // PostgreSQL usa TO_CHAR
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';

      ingresosQuery = `SELECT
         TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
         SUM(amount) as total_ingresos
       FROM payments
       WHERE status = 'succeeded'
       AND date::timestamp >= $1::timestamp AND date::timestamp < ($2::timestamp + INTERVAL '1 day')
       GROUP BY periodo
       ORDER BY periodo`;
      ingresosParams = [startDate, endDate];

      gastosQuery = `SELECT
         TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
         SUM(spend) as total_gastos
       FROM meta_ads
       WHERE date::timestamp >= $1::timestamp AND date::timestamp < ($2::timestamp + INTERVAL '1 day')
       GROUP BY periodo
       ORDER BY periodo`;
      gastosParams = [startDate, endDate];
    } else {
      // SQLite usa strftime
      const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';

      ingresosQuery = `SELECT
         strftime(?, date) as periodo,
         SUM(amount) as total_ingresos
       FROM payments
       WHERE status = 'succeeded'
       AND date >= ? AND date < DATE(?, '+1 day')
       GROUP BY periodo
       ORDER BY periodo`;
      ingresosParams = [dateFormat, startDate, endDate];

      gastosQuery = `SELECT
         strftime(?, date) as periodo,
         SUM(spend) as total_gastos
       FROM meta_ads
       WHERE date >= ? AND date < DATE(?, '+1 day')
       GROUP BY periodo
       ORDER BY periodo`;
      gastosParams = [dateFormat, startDate, endDate];
    }

    // Obtener ingresos agrupados
    const ingresosData = await db.all(ingresosQuery, ingresosParams);

    // Obtener gastos agrupados
    const gastosData = await db.all(gastosQuery, gastosParams);

    // Combinar datos y calcular ROAS por periodo
    const periodosMap = new Map();

    ingresosData.forEach(row => {
      periodosMap.set(row.periodo, {
        periodo: row.periodo,
        ingresos: parseFloat(row.total_ingresos),
        gastos: 0,
        roas: 0
      });
    });

    gastosData.forEach(row => {
      if (periodosMap.has(row.periodo)) {
        periodosMap.get(row.periodo).gastos = parseFloat(row.total_gastos);
      } else {
        periodosMap.set(row.periodo, {
          periodo: row.periodo,
          ingresos: 0,
          gastos: parseFloat(row.total_gastos),
          roas: 0
        });
      }
    });

    // Calcular ROAS para cada periodo y mapear a formato del frontend
    const chartData = Array.from(periodosMap.values()).map(data => ({
      date: data.periodo,
      ingresos: parseFloat(data.ingresos.toFixed(2)),
      gastado: parseFloat(data.gastos.toFixed(2)),
      ganancia: parseFloat((data.ingresos - data.gastos).toFixed(2))
    }));

    // Ordenar por periodo
    chartData.sort((a, b) => a.date.localeCompare(b.date));

    res.json(chartData);

  } catch (error) {
    logger.error(`Error en getChartData: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener datos de gráficas'
    });
  }
};

/**
 * Obtiene datos de ROAS agrupados por mes
 */
export const getRoasData = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    // Agrupar por mes - query según la base de datos
    let query, params;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    if (usePostgres) {
      query = `
        SELECT
          TO_CHAR(i.date::timestamp, 'YYYY-MM') as periodo,
          COALESCE(SUM(i.amount), 0) as ingresos,
          COALESCE(SUM(g.spend), 0) as gastos
        FROM (
          SELECT date, amount FROM payments WHERE status = 'succeeded' AND date::timestamp >= $1::timestamp AND date::timestamp < ($2::timestamp + INTERVAL '1 day')
        ) i
        LEFT JOIN (
          SELECT date, spend FROM meta_ads WHERE date::timestamp >= $3::timestamp AND date::timestamp < ($4::timestamp + INTERVAL '1 day')
        ) g ON TO_CHAR(i.date::timestamp, 'YYYY-MM') = TO_CHAR(g.date::timestamp, 'YYYY-MM')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate, startDate, endDate];
    } else {
      query = `
        SELECT
          strftime('%Y-%m', i.date) as periodo,
          COALESCE(SUM(i.amount), 0) as ingresos,
          COALESCE(SUM(g.spend), 0) as gastos
        FROM (
          SELECT date, amount FROM payments WHERE status = 'succeeded' AND date >= ? AND date < DATE(?, '+1 day')
        ) i
        LEFT JOIN (
          SELECT date, spend FROM meta_ads WHERE date >= ? AND date < DATE(?, '+1 day')
        ) g ON strftime('%Y-%m', i.date) = strftime('%Y-%m', g.date)
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate, startDate, endDate];
    }

    const data = await db.all(query, params);

    const roasData = data.map(row => ({
      label: row.periodo,
      value: row.gastos > 0 ? parseFloat((row.ingresos / row.gastos).toFixed(2)) : 0
    }));

    res.json(roasData);

  } catch (error) {
    logger.error(`Error en getRoasData: ${error.message}`);
    res.json([]);
  }
};

/**
 * Obtiene datos de nuevos clientes por día (contactos que han pagado)
 */
export const getNewCustomersData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    let query;
    let params;

    const usePostgres = Boolean(process.env.DATABASE_URL);

    if (usePostgres) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(created_at::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE total_paid > 0
        AND created_at::timestamp >= $1::timestamp AND created_at::timestamp < ($2::timestamp + INTERVAL '1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate];
    } else {
      const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';
      query = `
        SELECT
          strftime(?, created_at) as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE total_paid > 0
        AND created_at >= ? AND created_at < DATE(?, '+1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [dateFormat, startDate, endDate];
    }

    const data = await db.all(query, params);

    const customersData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    res.json(customersData);

  } catch (error) {
    logger.error(`Error en getNewCustomersData: ${error.message}`);
    res.json([]);
  }
};

/**
 * Obtiene datos de leads (todos los contactos nuevos) por periodo
 */
export const getLeadsData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    let query;
    let params;

    const usePostgres = Boolean(process.env.DATABASE_URL);

    if (usePostgres) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(created_at::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE created_at::timestamp >= $1::timestamp AND created_at::timestamp < ($2::timestamp + INTERVAL '1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate];
    } else {
      const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';
      query = `
        SELECT
          strftime(?, created_at) as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE created_at >= ? AND created_at < DATE(?, '+1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [dateFormat, startDate, endDate];
    }

    const data = await db.all(query, params);

    const leadsData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    res.json(leadsData);

  } catch (error) {
    logger.error(`Error en getLeadsData: ${error.message}`);
    res.json([]);
  }
};

/**
 * Obtiene datos de citas programadas por periodo
 * IMPORTANTE: Cuenta contactos ÚNICOS con cita, agrupados por fecha de creación del contacto
 * Esto permite atribución correcta de marketing (qué día se creó el contacto que agendó cita)
 *
 * Sistema OPTIMIZADO (método de Contacts):
 * 1. Carga TODOS los eventos de calendarios (1-5 llamadas API)
 * 2. Filtra contactos en memoria (rápido)
 * 3. Agrupa por periodo
 */
export const getAppointmentsData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    const usePostgres = Boolean(process.env.DATABASE_URL);

    // PASO 1: Obtener configuración de HighLevel
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    // PASO 2: Cargar TODOS los eventos de calendarios (híbrido DB + API)
    const contactsWithAppointments = config && config.api_token
      ? await getContactsWithAppointmentsHybrid(config.location_id, config.api_token)
      : new Set();

    logger.info(`📊 ${contactsWithAppointments.size} contactos con citas (híbrido DB + API)`);

    // PASO 3: Obtener contactos del rango de fechas
    const contactsQuery = usePostgres
      ? `
        SELECT id as contact_id, created_at
        FROM contacts
        WHERE created_at::timestamp >= $1::timestamp
          AND created_at::timestamp < ($2::timestamp + INTERVAL '1 day')
      `
      : `
        SELECT id as contact_id, created_at
        FROM contacts
        WHERE DATE(created_at) >= DATE(?)
          AND DATE(created_at) <= DATE(?)
      `;

    const contactsRaw = await db.all(contactsQuery, [startDate, endDate]);

    // PASO 4: Agrupar contactos con citas por periodo (fecha de creación)
    const periodMap = {};

    contactsRaw.forEach(contact => {
      if (contactsWithAppointments.has(contact.contact_id)) {
        const dateObj = new Date(contact.created_at);
        let periodKey;

        if (groupBy === 'month') {
          periodKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
        } else {
          periodKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
        }

        if (!periodMap[periodKey]) {
          periodMap[periodKey] = new Set();
        }
        periodMap[periodKey].add(contact.contact_id);
      }
    });

    // Convertir a formato de respuesta
    const appointmentsData = Object.keys(periodMap)
      .sort()
      .map(periodo => ({
        label: periodo,
        value: periodMap[periodo].size
      }));

    res.json(appointmentsData);

  } catch (error) {
    logger.error(`Error en getAppointmentsData: ${error.message}`);
    res.json([]);
  }
};

/**
 * Obtiene datos de ventas (pagos exitosos) por periodo
 */
export const getSalesData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    let query;
    let params;

    const usePostgres = Boolean(process.env.DATABASE_URL);

    if (usePostgres) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM payments
        WHERE status = 'succeeded'
        AND date::timestamp >= $1::timestamp AND date::timestamp < ($2::timestamp + INTERVAL '1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate];
    } else {
      const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';
      query = `
        SELECT
          strftime(?, date) as periodo,
          COUNT(*) as total
        FROM payments
        WHERE status = 'succeeded'
        AND date >= ? AND date < DATE(?, '+1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [dateFormat, startDate, endDate];
    }

    const data = await db.all(query, params);

    const salesData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    res.json(salesData);

  } catch (error) {
    logger.error(`Error en getSalesData: ${error.message}`);
    res.json([]);
  }
};

/**
 * Obtiene el estado del storage de la base de datos
 */
export const getStorageStatus = async (req, res) => {
  try {
    const STORAGE_LIMIT_GB = 1; // Límite configurado en render.yaml
    const WARNING_THRESHOLD = 0.8; // Alertar al 80%

    // Solo funciona en PostgreSQL (producción)
    const isPostgres = Boolean(process.env.DATABASE_URL);

    if (!isPostgres) {
      // En SQLite (local) devolver datos mock
      return res.json({
        sizeGB: 0.05,
        limitGB: STORAGE_LIMIT_GB,
        percentUsed: 5,
        warningThreshold: WARNING_THRESHOLD * 100,
        needsAttention: false,
        message: 'Desarrollo local (SQLite)'
      });
    }

    // Obtener tamaño actual de la BD
    const result = await db.get(`
      SELECT
        pg_size_pretty(pg_database_size(current_database())) as size_pretty,
        pg_database_size(current_database()) as size_bytes
    `);

    const sizeGB = result.size_bytes / (1024 * 1024 * 1024);
    const percentUsed = (sizeGB / STORAGE_LIMIT_GB) * 100;
    const needsAttention = percentUsed >= WARNING_THRESHOLD * 100;

    res.json({
      sizeGB: parseFloat(sizeGB.toFixed(2)),
      sizePretty: result.size_pretty,
      limitGB: STORAGE_LIMIT_GB,
      percentUsed: parseFloat(percentUsed.toFixed(1)),
      warningThreshold: WARNING_THRESHOLD * 100,
      needsAttention,
      message: needsAttention
        ? `⚠️ Base de datos usando ${percentUsed.toFixed(1)}% del storage disponible`
        : `✅ Storage en niveles normales (${percentUsed.toFixed(1)}%)`
    });

  } catch (error) {
    logger.error(`Error en getStorageStatus: ${error.message}`);
    res.status(500).json({
      error: 'No se pudo obtener el estado del storage'
    });
  }
};

/**
 * Obtiene datos de fuentes de tráfico para el gráfico de dona
 * Usa la misma lógica que Analytics: site_source_name → source_platform → utm_source
 */
export const getTrafficSources = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const usePostgres = Boolean(process.env.DATABASE_URL)

    let query, params

    if (usePostgres) {
      // PostgreSQL query - Obtener todos los campos para normalización con prioridad 1-4
      query = `
        SELECT
          referrer_url,
          site_source_name,
          utm_source,
          source_platform,
          COUNT(*) as value
        FROM sessions
        WHERE started_at::timestamp >= $1::timestamp
          AND started_at::timestamp < ($2::timestamp + INTERVAL '1 day')
        GROUP BY referrer_url, site_source_name, utm_source, source_platform
        ORDER BY value DESC
      `
      params = [startDate, endDate]
    } else {
      // SQLite query - Obtener todos los campos para normalización con prioridad 1-4
      query = `
        SELECT
          referrer_url,
          site_source_name,
          utm_source,
          source_platform,
          COUNT(*) as value
        FROM sessions
        WHERE DATE(started_at) >= DATE(?)
          AND DATE(started_at) <= DATE(?)
        GROUP BY referrer_url, site_source_name, utm_source, source_platform
        ORDER BY value DESC
      `
      params = [startDate, endDate]
    }

    const sources = await db.all(query, params)

    // Normalizar nombres usando prioridad 1-4 y agrupar por plataforma normalizada
    const sourcesMap = new Map()

    sources.forEach(source => {
      // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
      const normalizedName = normalizeTrafficSource({
        referrer_url: source.referrer_url,
        site_source_name: source.site_source_name,
        utm_source: source.utm_source,
        source_platform: source.source_platform
      })
      const currentValue = sourcesMap.get(normalizedName) || 0
      sourcesMap.set(normalizedName, currentValue + parseInt(source.value))
    })

    // Mapear colores por plataforma
    const colorMap = {
      'Facebook': '#1877f2',
      'Google': '#4285f4',
      'Instagram': '#c32aa3',
      'TikTok': '#ee1d52',
      'Bing': '#00a4ef',
      'Microsoft': '#00a4ef',
      'Twitter': '#1da1f2',
      'LinkedIn': '#0a66c2',
      'YouTube': '#ff0000',
      'Messenger': '#0084ff',
      'WhatsApp': '#25d366',
      'Snapchat': '#fffc00',
      'Pinterest': '#e60023',
      'Reddit': '#ff4500',
      'Telegram': '#0088cc',
      'Email': '#ea4335',
      'Directo': '#6b7280',
      'Orgánico': '#10b981',
      'Referencia': '#8b5cf6',
      'Yahoo': '#7b0099',
      'DuckDuckGo': '#de5833',
      'Otro': '#94a3b8',
      'Desconocido': '#64748b'
    }

    // Convertir Map a array y ordenar por valor
    const data = Array.from(sourcesMap.entries())
      .map(([name, value]) => ({
        name,
        value,
        color: colorMap[name] || '#6b7280'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10) // Top 10 fuentes

    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error en getTrafficSources: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error al obtener fuentes de tráfico' })
  }
}

/**
 * Obtiene TODOS los ingresos y gastos (no solo atribuidos)
 * Para el gráfico principal del Dashboard
 */
export const getFinancialOverview = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Query para TODOS los ingresos (payments con status succeeded)
    const revenueQuery = usePostgres
      ? `
        SELECT
          TO_CHAR(date::date, 'YYYY-MM-DD') as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date::date >= $1::date
          AND date::date < ($2::date + INTERVAL '1 day')
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          strftime('%Y-%m-%d', date) as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date >= ?
          AND date < DATE(?, '+1 day')
        GROUP BY day
        ORDER BY day ASC
      `;

    // Query para TODOS los gastos de publicidad
    const spendQuery = usePostgres
      ? `
        SELECT
          TO_CHAR(date::date, 'YYYY-MM-DD') as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date::date >= $1::date
          AND date::date < ($2::date + INTERVAL '1 day')
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          strftime('%Y-%m-%d', date) as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date >= ?
          AND date < DATE(?, '+1 day')
        GROUP BY day
        ORDER BY day ASC
      `;

    const params = [startDate, endDate];

    const [revenueData, spendData] = await Promise.all([
      db.all(revenueQuery, params),
      db.all(spendQuery, params)
    ]);

    logger.info(`Ingresos totales encontrados: ${revenueData.length} días con pagos`);
    logger.info(`Gastos encontrados: ${spendData.length} días con gastos publicitarios`);

    // Si no hay datos, retornar vacío
    if (revenueData.length === 0 && spendData.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Crear mapas por fecha
    const revenueMap = new Map();
    revenueData.forEach(row => {
      revenueMap.set(row.day, parseFloat(row.revenue || 0));
    });

    const spendMap = new Map();
    spendData.forEach(row => {
      spendMap.set(row.day, parseFloat(row.spend || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...revenueMap.keys(), ...spendMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado: { label, value (ingresos), value2 (gastos) }
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: revenueMap.get(date) || 0,  // Ingresos totales
      value2: spendMap.get(date) || 0     // Gastos de publicidad
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getFinancialOverview: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener panorama financiero'
    });
  }
};

/**
 * Obtiene datos del funnel de conversión
 * Usa labels personalizados del usuario
 */
export const getFunnelData = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const usePostgres = Boolean(process.env.DATABASE_URL)

    // Obtener labels personalizados del usuario
    const config = await db.get('SELECT custom_labels FROM highlevel_config LIMIT 1')
    const defaultLabels = {
      customer: 'Cliente',
      customers: 'Clientes',
      lead: 'Interesado',
      leads: 'Interesados'
    }

    let labels = defaultLabels
    if (config && config.custom_labels) {
      try {
        const parsed = JSON.parse(config.custom_labels)
        labels = { ...defaultLabels, ...parsed }
      } catch (error) {
        logger.warn('Error parsing custom_labels, usando valores por defecto')
      }
    }

    let visitorsQuery, leadsQuery, appointmentsQuery, customersQuery
    let params

    if (usePostgres) {
      // PostgreSQL queries
      visitorsQuery = `
        SELECT COUNT(DISTINCT visitor_id) as count
        FROM sessions
        WHERE started_at::timestamp >= $1::timestamp
          AND started_at::timestamp < ($2::timestamp + INTERVAL '1 day')
      `
      leadsQuery = `
        SELECT COUNT(*) as count
        FROM contacts
        WHERE created_at::timestamp >= $1::timestamp
          AND created_at::timestamp < ($2::timestamp + INTERVAL '1 day')
      `
      appointmentsQuery = `
        SELECT COUNT(DISTINCT COALESCE(contact_id, id)) as count
        FROM appointments
        WHERE start_time::timestamp >= $1::timestamp
          AND start_time::timestamp < ($2::timestamp + INTERVAL '1 day')
          AND contact_id IS NOT NULL
      `
      customersQuery = `
        SELECT COUNT(DISTINCT id) as count
        FROM contacts
        WHERE purchases_count > 0
          AND created_at::timestamp >= $1::timestamp
          AND created_at::timestamp < ($2::timestamp + INTERVAL '1 day')
      `
      params = [startDate, endDate]
    } else {
      // SQLite queries
      visitorsQuery = `
        SELECT COUNT(DISTINCT visitor_id) as count
        FROM sessions
        WHERE DATE(started_at) >= DATE(?)
          AND DATE(started_at) <= DATE(?)
      `
      leadsQuery = `
        SELECT COUNT(*) as count
        FROM contacts
        WHERE DATE(created_at) >= DATE(?)
          AND DATE(created_at) <= DATE(?)
      `
      appointmentsQuery = `
        SELECT COUNT(DISTINCT COALESCE(contact_id, id)) as count
        FROM appointments
        WHERE DATE(start_time) >= DATE(?)
          AND DATE(start_time) <= DATE(?)
          AND contact_id IS NOT NULL
      `
      customersQuery = `
        SELECT COUNT(DISTINCT id) as count
        FROM contacts
        WHERE purchases_count > 0
          AND DATE(created_at) >= DATE(?)
          AND DATE(created_at) <= DATE(?)
      `
      params = [startDate, endDate]
    }

    const visitors = await db.get(visitorsQuery, params)
    const leadsData = await db.get(leadsQuery, params)
    const appointments = await db.get(appointmentsQuery, params)
    const customersData = await db.get(customersQuery, params)

    // Usar labels personalizados en la respuesta
    const data = [
      { stage: 'Visitantes', value: parseInt(visitors.count) || 0 },
      { stage: labels.leads, value: parseInt(leadsData.count) || 0 },
      { stage: 'Citas', value: parseInt(appointments.count) || 0 },
      { stage: labels.customers, value: parseInt(customersData.count) || 0 }
    ]

    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error en getFunnelData: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error al obtener datos del funnel' })
  }
}
