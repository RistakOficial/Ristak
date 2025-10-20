import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js';
import { normalizeTrafficSource } from '../utils/trafficSourceNormalizer.js';
import { getGroupExpression } from '../services/analyticsService.js';
import { DateTime } from 'luxon';
import { getContactsWithAppointmentsHybrid } from '../services/appointmentsMerge.js';
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js';

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

const buildContactFilters = async (range) => {
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

  // Aplicar filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters();
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);
  if (hiddenCondition) {
    filters.push(hiddenCondition);
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

  const { filters: contactFilters, params: contactParams } = await buildContactFilters(range);
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

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('date', groupBy, timezone);

    let ingresosQuery, gastosQuery;
    let ingresosParams, gastosParams;

    if (usePostgres) {
      ingresosQuery = `SELECT
         ${dateExpression} as periodo,
         SUM(amount) as total_ingresos
       FROM payments
       WHERE status = 'succeeded'
       AND date >= $1 AND date <= $2
       GROUP BY periodo
       ORDER BY periodo`;
      ingresosParams = [range.startUtc, range.endUtc];

      gastosQuery = `SELECT
         ${dateExpression} as periodo,
         SUM(spend) as total_gastos
       FROM meta_ads
       WHERE date >= $1 AND date <= $2
       GROUP BY periodo
       ORDER BY periodo`;
      gastosParams = [range.startUtc, range.endUtc];
    } else {
      ingresosQuery = `SELECT
         ${dateExpression} as periodo,
         SUM(amount) as total_ingresos
       FROM payments
       WHERE status = 'succeeded'
       AND date >= ? AND date <= ?
       GROUP BY periodo
       ORDER BY periodo`;
      ingresosParams = [range.startUtc, range.endUtc];

      gastosQuery = `SELECT
         ${dateExpression} as periodo,
         SUM(spend) as total_gastos
       FROM meta_ads
       WHERE date >= ? AND date <= ?
       GROUP BY periodo
       ORDER BY periodo`;
      gastosParams = [range.startUtc, range.endUtc];
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Agrupar por mes con timezone dinámico
    const monthExpression = getGroupExpression('date', 'month', timezone);

    let query, params;

    if (usePostgres) {
      query = `
        SELECT
          ${monthExpression} as periodo,
          COALESCE(SUM(i.amount), 0) as ingresos,
          COALESCE(SUM(g.spend), 0) as gastos
        FROM (
          SELECT date, amount FROM payments WHERE status = 'succeeded' AND date >= $1 AND date <= $2
        ) i
        LEFT JOIN (
          SELECT date, spend FROM meta_ads WHERE date >= $3 AND date <= $4
        ) g ON ${getGroupExpression('i.date', 'month', timezone)} = ${getGroupExpression('g.date', 'month', timezone)}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc, range.startUtc, range.endUtc];
    } else {
      query = `
        SELECT
          ${monthExpression} as periodo,
          COALESCE(SUM(i.amount), 0) as ingresos,
          COALESCE(SUM(g.spend), 0) as gastos
        FROM (
          SELECT date, amount FROM payments WHERE status = 'succeeded' AND date >= ? AND date <= ?
        ) i
        LEFT JOIN (
          SELECT date, spend FROM meta_ads WHERE date >= ? AND date <= ?
        ) g ON ${getGroupExpression('i.date', 'month', timezone)} = ${getGroupExpression('g.date', 'month', timezone)}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc, range.startUtc, range.endUtc];
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    let query;
    let params;

    if (usePostgres) {
      const conditions = ['total_paid > 0', 'created_at >= $1', 'created_at <= $2'];
      if (hiddenCondition) conditions.push(hiddenCondition);

      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE ${conditions.join(' AND ')}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
    } else {
      const conditions = ['total_paid > 0', 'created_at >= ?', 'created_at <= ?'];
      if (hiddenCondition) conditions.push(hiddenCondition);

      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE ${conditions.join(' AND ')}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
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
 * Obtiene datos de visitantes únicos desde sessions por periodo
 */
export const getVisitorsData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('started_at', groupBy, timezone);

    let query;
    let params;

    if (usePostgres) {
      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(DISTINCT visitor_id) as total
        FROM sessions
        WHERE started_at >= $1 AND started_at <= $2
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
    } else {
      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(DISTINCT visitor_id) as total
        FROM sessions
        WHERE started_at >= ? AND started_at <= ?
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
    }

    const data = await db.all(query, params);

    const visitorsData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    res.json(visitorsData);

  } catch (error) {
    logger.error(`Error en getVisitorsData: ${error.message}`);
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    let query;
    let params;

    if (usePostgres) {
      const conditions = ['created_at >= $1', 'created_at <= $2'];
      if (hiddenCondition) conditions.push(hiddenCondition);

      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE ${conditions.join(' AND ')}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
    } else {
      const conditions = ['created_at >= ?', 'created_at <= ?'];
      if (hiddenCondition) conditions.push(hiddenCondition);

      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE ${conditions.join(' AND ')}
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // PASO 1: Obtener configuración de HighLevel
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    // PASO 2: Cargar TODOS los eventos de calendarios (híbrido DB + API)
    const contactsWithAppointments = config && config.api_token
      ? await getContactsWithAppointmentsHybrid(config.location_id, config.api_token)
      : new Set();

    logger.info(`📊 ${contactsWithAppointments.size} contactos con citas (híbrido DB + API)`);

    // PASO 3: Obtener contactos del rango de fechas
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    const contactsQuery = usePostgres
      ? `
        SELECT id as contact_id, created_at
        FROM contacts
        WHERE created_at >= $1 AND created_at <= $2
          ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      `
      : `
        SELECT id as contact_id, created_at
        FROM contacts
        WHERE created_at >= ? AND created_at <= ?
          ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      `;

    const contactsRaw = await db.all(contactsQuery, [range.startUtc, range.endUtc]);

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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('date', groupBy, timezone);

    let query;
    let params;

    if (usePostgres) {
      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM payments
        WHERE status = 'succeeded'
        AND date >= $1 AND date <= $2
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
    } else {
      query = `
        SELECT
          ${dateExpression} as periodo,
          COUNT(*) as total
        FROM payments
        WHERE status = 'succeeded'
        AND date >= ? AND date <= ?
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [range.startUtc, range.endUtc];
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
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
        WHERE started_at >= $1 AND started_at <= $2
        GROUP BY referrer_url, site_source_name, utm_source, source_platform
        ORDER BY value DESC
      `
      params = [range.startUtc, range.endUtc]
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
        WHERE started_at >= ? AND started_at <= ?
        GROUP BY referrer_url, site_source_name, utm_source, source_platform
        ORDER BY value DESC
      `
      params = [range.startUtc, range.endUtc]
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

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const usePostgres = Boolean(process.env.DATABASE_URL);

    // Usar getGroupExpression() con timezone dinámico
    const dayExpression = getGroupExpression('date', 'day', timezone);

    // Query para TODOS los ingresos (payments con status succeeded)
    const revenueQuery = usePostgres
      ? `
        SELECT
          ${dayExpression} as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date >= $1 AND date <= $2
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          ${dayExpression} as day,
          SUM(amount) as revenue
        FROM payments
        WHERE status = 'succeeded'
          AND date >= ? AND date <= ?
        GROUP BY day
        ORDER BY day ASC
      `;

    // Query para TODOS los gastos de publicidad
    const spendQuery = usePostgres
      ? `
        SELECT
          ${dayExpression} as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date >= $1 AND date <= $2
        GROUP BY day
        ORDER BY day ASC
      `
      : `
        SELECT
          ${dayExpression} as day,
          SUM(spend) as spend
        FROM meta_ads
        WHERE date >= ? AND date <= ?
        GROUP BY day
        ORDER BY day ASC
      `;

    const params = [range.startUtc, range.endUtc];

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
 * Obtiene datos del funnel de conversión con 3 modos de atribución
 *
 * @param {string} scope - Modo de atribución:
 *   - 'all': Agrupa cada métrica por fecha del evento (pagos reales, citas agendadas, etc.)
 *   - 'attribution': Agrupa TODO por fecha de creación del contacto (todos los contactos)
 *   - 'campaigns': Agrupa por fecha de creación + solo contactos con ad_id
 *
 * LÓGICA POR MÉTRICA:
 *
 * 1. VISITANTES: Siempre de sessions (no cambia con scope)
 *
 * 2. LEADS:
 *    - all/attribution: COUNT(*) FROM contacts WHERE created_at BETWEEN start AND end
 *    - campaigns: Igual + filtro attribution_ad_id IS NOT NULL
 *
 * 3. CITAS:
 *    - all: Híbrido DB+API filtrado por date_added (cuando se agendó)
 *    - attribution/campaigns: getContactsWithAppointmentsHybrid() agrupado por created_at del contacto
 *
 * 4. CLIENTES NUEVOS:
 *    - all: Contactos cuyo PRIMER pago está en el rango (MIN(date) FROM payments)
 *    - attribution/campaigns: COUNT(DISTINCT) WHERE created_at BETWEEN start AND end AND purchases_count > 0
 */
export const getFunnelData = async (req, res) => {
  try {
    const { startDate, endDate, scope = 'all' } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const usePostgres = Boolean(process.env.DATABASE_URL)
    const isAttributed = scope === 'campaigns' || scope === 'attributed'
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution'

    // Obtener labels personalizados del usuario
    const hlConfig = await db.get('SELECT custom_labels, location_id, api_token FROM highlevel_config LIMIT 1')
    const defaultLabels = {
      customer: 'Cliente',
      customers: 'Clientes',
      lead: 'Interesado',
      leads: 'Interesados'
    }

    let labels = defaultLabels
    if (hlConfig && hlConfig.custom_labels) {
      try {
        const parsed = JSON.parse(hlConfig.custom_labels)
        labels = { ...defaultLabels, ...parsed }
      } catch (error) {
        logger.warn('Error parsing custom_labels, usando valores por defecto')
      }
    }

    // ========================================
    // 1. VISITANTES (según scope)
    // ========================================
    let visitorsCount = 0

    if (!useContactAttribution) {
      // Vista "Todos": Todos los visitantes en el rango de fechas
      let visitorsQuery, visitorsParams

      if (usePostgres) {
        visitorsQuery = `
          SELECT COUNT(DISTINCT visitor_id) as count
          FROM sessions
          WHERE started_at >= $1 AND started_at <= $2
        `
        visitorsParams = [range.startUtc, range.endUtc]
      } else {
        visitorsQuery = `
          SELECT COUNT(DISTINCT visitor_id) as count
          FROM sessions
          WHERE started_at >= ? AND started_at <= ?
        `
        visitorsParams = [range.startUtc, range.endUtc]
      }

      const visitorsResult = await db.get(visitorsQuery, visitorsParams)
      visitorsCount = parseInt(visitorsResult?.count || 0)
    } else {
      // Vista "Último toque": Solo visitantes que SE CONVIRTIERON en contacto
      // Agrupa por fecha de creación del contacto
      let visitorsQuery, visitorsParams

      if (usePostgres) {
        visitorsQuery = `
          SELECT COUNT(DISTINCT s.visitor_id) as count
          FROM sessions s
          INNER JOIN contacts c ON c.id = s.contact_id
          WHERE c.created_at >= $1 AND c.created_at <= $2
            ${isAttributed ? `AND c.attribution_ad_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM meta_ads ma
              WHERE ma.ad_id = c.attribution_ad_id
                AND DATE(ma.date) = DATE(c.created_at)
            )` : ''}
        `
        visitorsParams = [range.startUtc, range.endUtc]
      } else {
        visitorsQuery = `
          SELECT COUNT(DISTINCT s.visitor_id) as count
          FROM sessions s
          INNER JOIN contacts c ON c.id = s.contact_id
          WHERE c.created_at >= ? AND c.created_at <= ?
            ${isAttributed ? `AND c.attribution_ad_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM meta_ads ma
              WHERE ma.ad_id = c.attribution_ad_id
                AND DATE(ma.date) = DATE(c.created_at)
            )` : ''}
        `
        visitorsParams = [range.startUtc, range.endUtc]
      }

      const visitorsResult = await db.get(visitorsQuery, visitorsParams)
      visitorsCount = parseInt(visitorsResult?.count || 0)
    }

    // ========================================
    // 2. LEADS (según scope)
    // ========================================
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    let leadsQuery, leadsParams

    if (usePostgres) {
      const conditions = ['created_at >= $1', 'created_at <= $2'];
      if (isAttributed) {
        conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = contacts.attribution_ad_id
            AND DATE(ma.date) = DATE(contacts.created_at)
        )`);
      }
      if (hiddenCondition) conditions.push(hiddenCondition);

      leadsQuery = `
        SELECT COUNT(*) as count
        FROM contacts
        WHERE ${conditions.join(' AND ')}
      `;
      leadsParams = [range.startUtc, range.endUtc];
    } else {
      const conditions = ['created_at >= ?', 'created_at <= ?'];
      if (isAttributed) {
        conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = contacts.attribution_ad_id
            AND DATE(ma.date) = DATE(contacts.created_at)
        )`);
      }
      if (hiddenCondition) conditions.push(hiddenCondition);

      leadsQuery = `
        SELECT COUNT(*) as count
        FROM contacts
        WHERE ${conditions.join(' AND ')}
      `;
      leadsParams = [range.startUtc, range.endUtc];
    }

    const leadsData = await db.get(leadsQuery, leadsParams)

    // ========================================
    // 3. CITAS (según scope)
    // ========================================
    let appointmentsCount = 0

    // Obtener calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds()

    if (useContactAttribution) {
      // Vista "Último toque": Contar contactos creados en el rango que TIENEN cita (cualquier fecha)
      const contactsWithAppointments = hlConfig && hlConfig.api_token
        ? await getContactsWithAppointmentsHybrid(hlConfig.location_id, hlConfig.api_token, attributionCalendarIds)
        : new Set()

      // Contar cuántos contactos del rango tienen cita
      if (usePostgres) {
        const conditions = ['created_at >= $1', 'created_at <= $2'];
        if (isAttributed) {
          conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = contacts.attribution_ad_id
              AND DATE(ma.date) = DATE(contacts.created_at)
          )`);
        }
        if (hiddenCondition) conditions.push(hiddenCondition);

        const contactsQuery = `
          SELECT id
          FROM contacts
          WHERE ${conditions.join(' AND ')}
        `;
        const contactsRaw = await db.all(contactsQuery, [range.startUtc, range.endUtc]);
        appointmentsCount = contactsRaw.filter(c => contactsWithAppointments.has(c.id)).length;
      } else {
        const conditions = ['created_at >= ?', 'created_at <= ?'];
        if (isAttributed) {
          conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = contacts.attribution_ad_id
              AND DATE(ma.date) = DATE(contacts.created_at)
          )`);
        }
        if (hiddenCondition) conditions.push(hiddenCondition);

        const contactsQuery = `
          SELECT id
          FROM contacts
          WHERE ${conditions.join(' AND ')}
        `;
        const contactsRaw = await db.all(contactsQuery, [range.startUtc, range.endUtc]);
        appointmentsCount = contactsRaw.filter(c => contactsWithAppointments.has(c.id)).length;
      }
    } else {
      // Vista "Todos": Híbrido DB+API filtrado por date_added
      const { loadAppointmentsFromDB, loadAppointmentsFromAPI, mergeAppointments } = await import('../services/appointmentsMerge.js')

      const [dbAppointments, apiAppointments] = await Promise.all([
        loadAppointmentsFromDB({
          calendarIds: attributionCalendarIds,
          startDate: range.startUtc,
          endDate: range.endUtc
        }),
        hlConfig && hlConfig.api_token
          ? loadAppointmentsFromAPI(hlConfig.location_id, hlConfig.api_token, attributionCalendarIds)
          : []
      ])

      const allAppointments = mergeAppointments(dbAppointments, apiAppointments, 'oldest_date')

      // Filtrar por rango de dateAdded
      const appointmentsInRange = allAppointments.filter(apt => {
        if (!apt.dateAdded) return false
        const dateAdded = new Date(apt.dateAdded)
        const start = new Date(range.startUtc)
        const end = new Date(range.endUtc)
        return dateAdded >= start && dateAdded <= end
      })

      // Contar contactos únicos
      const uniqueContactIds = new Set(appointmentsInRange.map(apt => apt.contactId).filter(Boolean))
      appointmentsCount = uniqueContactIds.size
    }

    // ========================================
    // 4. CLIENTES NUEVOS (según scope)
    // ========================================
    let customersCount = 0

    if (useContactAttribution) {
      // Vista "Último toque": Contactos creados en el rango con purchases_count > 0
      if (usePostgres) {
        const conditions = ['purchases_count > 0', 'created_at >= $1', 'created_at <= $2'];
        if (isAttributed) {
          conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = contacts.attribution_ad_id
              AND DATE(ma.date) = DATE(contacts.created_at)
          )`);
        }
        if (hiddenCondition) conditions.push(hiddenCondition);

        const customersQuery = `
          SELECT COUNT(DISTINCT id) as count
          FROM contacts
          WHERE ${conditions.join(' AND ')}
        `;
        const customersData = await db.get(customersQuery, [range.startUtc, range.endUtc]);
        customersCount = parseInt(customersData?.count || 0);
      } else {
        const conditions = ['purchases_count > 0', 'created_at >= ?', 'created_at <= ?'];
        if (isAttributed) {
          conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = contacts.attribution_ad_id
              AND DATE(ma.date) = DATE(contacts.created_at)
          )`);
        }
        if (hiddenCondition) conditions.push(hiddenCondition);

        const customersQuery = `
          SELECT COUNT(DISTINCT id) as count
          FROM contacts
          WHERE ${conditions.join(' AND ')}
        `;
        const customersData = await db.get(customersQuery, [range.startUtc, range.endUtc]);
        customersCount = parseInt(customersData?.count || 0);
      }
    } else {
      // Vista "Todos": Contactos cuyo PRIMER pago está en el rango
      const SUCCESS_PAYMENT_STATUSES = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
      const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')

      if (usePostgres) {
        const firstPaymentQuery = `
          SELECT COUNT(DISTINCT c.id) as count
          FROM contacts c
          INNER JOIN (
            SELECT contact_id, MIN(date) as first_payment_date
            FROM payments
            WHERE LOWER(status) IN (${statusPlaceholders})
            GROUP BY contact_id
          ) first_p ON first_p.contact_id = c.id
          WHERE first_p.first_payment_date >= $${SUCCESS_PAYMENT_STATUSES.length + 1}
            AND first_p.first_payment_date <= $${SUCCESS_PAYMENT_STATUSES.length + 2}
        `
        const firstPaymentParams = [...SUCCESS_PAYMENT_STATUSES, range.startUtc, range.endUtc]
        const customersData = await db.get(firstPaymentQuery, firstPaymentParams)
        customersCount = parseInt(customersData?.count || 0)
      } else {
        const firstPaymentQuery = `
          SELECT COUNT(DISTINCT c.id) as count
          FROM contacts c
          INNER JOIN (
            SELECT contact_id, MIN(date) as first_payment_date
            FROM payments
            WHERE LOWER(status) IN (${statusPlaceholders})
            GROUP BY contact_id
          ) first_p ON first_p.contact_id = c.id
          WHERE first_p.first_payment_date >= ?
            AND first_p.first_payment_date <= ?
        `
        const firstPaymentParams = [...SUCCESS_PAYMENT_STATUSES, range.startUtc, range.endUtc]
        const customersData = await db.get(firstPaymentQuery, firstPaymentParams)
        customersCount = parseInt(customersData?.count || 0)
      }
    }

    // ========================================
    // 5. RESPUESTA
    // ========================================
    const data = [
      { stage: 'Visitantes', value: visitorsCount },
      { stage: labels.leads, value: parseInt(leadsData?.count || 0) },
      { stage: 'Citas', value: appointmentsCount },
      { stage: labels.customers, value: customersCount }
    ]

    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error en getFunnelData: ${error.message}`)
    logger.error(error.stack)
    res.status(500).json({ success: false, error: 'Error al obtener datos del funnel' })
  }
}

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]|null>} Array de calendar IDs o null si no están configurados
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    if (!config || !config.config_value) {
      return null // null = usar todos los calendarios
    }

    const calendarIds = JSON.parse(config.config_value)
    return calendarIds.length > 0 ? calendarIds : null
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución: ${error.message} - usando TODOS`)
    return null
  }
}
