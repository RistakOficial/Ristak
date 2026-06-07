import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js';
import { getGroupExpression } from '../services/analyticsService.js';
import { getManualBusinessExpensesTotalForRange } from '../services/manualBusinessExpensesService.js';
import { getContactSourceBreakdown } from '../services/contactSourceService.js';
import { getTrafficDistributions, getWhatsAppApiSourceBreakdown, getWhatsAppApiNumberBreakdown, getLeadsContactIds } from '../services/originDistributionService.js';
import { normalizeTrafficSource } from '../utils/trafficSourceNormalizer.js';
import { DateTime } from 'luxon';
import { getContactsWithAppointmentsHybrid, getContactsWithShowedAppointmentsHybrid } from '../services/appointmentsMerge.js';
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js';
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES, successfulPaymentStatusCondition } from '../utils/paymentMode.js';

const isPostgres = Boolean(process.env.DATABASE_URL);

function timestampDateExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `DATE(${column})`;
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''");
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`;
}

function metaAdsSameLocalDayCondition(metaDateColumn, timestampColumn, timezone = 'UTC') {
  const metaDateExpr = isPostgres ? `(${metaDateColumn})::date` : `DATE(${metaDateColumn})`;
  return `${metaDateExpr} = ${timestampDateExpression(timestampColumn, timezone)}`;
}

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

// NUEVA: Filtros específicos para meta_ads (columna date es TEXT "YYYY-MM-DD")
const buildMetaAdsDateFilters = (range) => {
  const filters = [];
  const params = [];

  // IMPORTANTE: La columna 'date' en meta_ads es TEXT con formato "YYYY-MM-DD"
  // Por eso usamos startZoned.toISODate() en vez de startUtc (que incluye hora)
  // Si usamos startUtc (ej: "2025-10-01T05:00:00.000Z"), la comparación TEXT falla
  if (range.startZoned) {
    filters.push('date >= ?');
    params.push(range.startZoned.toISODate());
  }

  if (range.endZoned) {
    filters.push('date <= ?');
    params.push(range.endZoned.toISODate());
  }

  return { filters, params };
};

const coerceZonedDateTime = (value, fallbackUtc, zone) => {
  if (value?.isValid) return value;

  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone });
    if (parsed.isValid) return parsed;
  }

  if (fallbackUtc) {
    const parsed = DateTime.fromISO(fallbackUtc, { zone: 'utc' }).setZone(zone);
    if (parsed.isValid) return parsed;
  }

  return null;
};

const getLocalDateRange = (range) => {
  const zone = range.appliedTimezone || 'UTC';
  const start = coerceZonedDateTime(range.startZoned, range.startUtc, zone);
  const end = coerceZonedDateTime(range.endZoned, range.endUtc, zone);

  if (!start || !end) return null;

  return {
    from: start.toISODate(),
    to: end.toISODate()
  };
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
  // Obtener filtro de contactos ocultos
  const hiddenFilters = await getHiddenContactFilters();
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

  const successfulPayments = successfulPaymentStatusCondition();
  const paymentsFilters = [successfulPayments.sql, nonTestPaymentCondition()];
  const paymentsParams = [...successfulPayments.params];
  const { filters: dateFilters, params: dateParams } = buildDateFilters(range);
  paymentsFilters.push(...dateFilters);
  paymentsParams.push(...dateParams);

  // Filtrar payments de contactos ocultos
  if (hiddenCondition) {
    paymentsFilters.push(`contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})`);
  }

  const ingresosQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE ${paymentsFilters.join(' AND ')}`;
  const ingresosRow = await db.get(ingresosQuery, paymentsParams);
  const ingresosNetos = parseFloat(ingresosRow?.total || 0);

  const gastosFilters = [];
  const gastosParams = [];
  const { filters: spendDateFilters, params: spendDateParams } = buildMetaAdsDateFilters(range);
  if (spendDateFilters.length) {
    gastosFilters.push(...spendDateFilters);
    gastosParams.push(...spendDateParams);
  }

  const gastosWhere = gastosFilters.length ? `WHERE ${gastosFilters.join(' AND ')}` : '';
  const gastosQuery = `SELECT COALESCE(SUM(spend), 0) as total FROM meta_ads ${gastosWhere}`;
  const gastosRow = await db.get(gastosQuery, gastosParams);
  const gastosPublicidad = parseFloat(gastosRow?.total || 0);

  const refundsFilters = ['status = ?', nonTestPaymentCondition()];
  const refundsParams = ['refunded'];
  const { filters: refundDateFilters, params: refundDateParams } = buildDateFilters(range);
  refundsFilters.push(...refundDateFilters);
  refundsParams.push(...refundDateParams);

  // Filtrar refunds de contactos ocultos
  if (hiddenCondition) {
    refundsFilters.push(`contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})`);
  }

  const refundsQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE ${refundsFilters.join(' AND ')}`;
  const refundsRow = await db.get(refundsQuery, refundsParams);
  const reembolsos = parseFloat(refundsRow?.total || 0);

  // Calcular promedio de pagos INDIVIDUALES (no total_paid de contactos)
  // IMPORTANTE: Solo pagos exitosos según Mandamiento #11
  const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',');

  const paymentsAvgFilters = [`LOWER(status) IN (${statusPlaceholders})`, nonTestPaymentCondition()];
  const paymentsAvgParams = [...SUCCESS_PAYMENT_STATUSES];

  const { filters: avgDateFilters, params: avgDateParams } = buildDateFilters(range);
  paymentsAvgFilters.push(...avgDateFilters);
  paymentsAvgParams.push(...avgDateParams);

  // Filtrar payments de contactos ocultos
  if (hiddenCondition) {
    paymentsAvgFilters.push(`contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})`);
  }

  const avgPaymentQuery = `SELECT COALESCE(AVG(amount), 0) as avg_payment FROM payments WHERE ${paymentsAvgFilters.join(' AND ')}`;
  const avgPaymentRow = await db.get(avgPaymentQuery, paymentsAvgParams);
  const ltvPromedio = parseFloat(avgPaymentRow?.avg_payment || 0);

  const gananciaBruta = ingresosNetos - gastosPublicidad;
  const roas = gastosPublicidad > 0 ? ingresosNetos / gastosPublicidad : 0;

  // Calcular costos dinámicamente desde la tabla costs
  let totalCostos = 0;
  try {
    const costs = await db.all('SELECT * FROM costs WHERE is_active = 1');

    for (const cost of costs) {
      let amount = 0;

      if (cost.calculation_type === 'percentage') {
        // Porcentaje sobre revenue
        if (cost.applies_to === 'revenue') {
          amount = (ingresosNetos * cost.value) / 100;
        }
      } else if (cost.calculation_type === 'fixed') {
        // Monto fijo
        amount = cost.value;
      }

      totalCostos += amount;
    }
  } catch (error) {
    logger.warn('Error calculando costos desde tabla costs:', error.message);
    // Fallback: usar IVA del 16% como antes
    totalCostos = ingresosNetos * 0.16;
  }

  try {
    const localDateRange = getLocalDateRange(range);
    const manualBusinessExpenses = localDateRange
      ? await getManualBusinessExpensesTotalForRange(localDateRange)
      : 0;

    totalCostos += manualBusinessExpenses;
  } catch (error) {
    logger.warn('Error calculando costos variables manuales:', error.message);
  }

  const gananciaNeta = gananciaBruta - totalCostos;

  return {
    ingresosNetos,
    gastosPublicidad,
    gananciaBruta,
    roas,
    totalCostos,  // Reemplaza ivaPagar
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
        endUtc: prevEnd.toUTC().toISO({ suppressMilliseconds: false }),
        appliedTimezone: range.appliedTimezone,
        isFiltered: true,
        startZoned: prevStart,
        endZoned: prevEnd
      };
    } else {
      const zone = range.appliedTimezone;
      const nowZoned = DateTime.now().setZone(zone);
      const currentMonthStart = nowZoned.startOf('month');
      const previousMonthStart = currentMonthStart.minus({ months: 1 }).startOf('month');
      const previousMonthEnd = currentMonthStart.minus({ days: 1 }).endOf('day');
      previousRange = {
        startUtc: previousMonthStart.toUTC().toISO({ suppressMilliseconds: false }),
        endUtc: previousMonthEnd.toUTC().toISO({ suppressMilliseconds: false }),
        appliedTimezone: zone,
        isFiltered: true,
        startZoned: previousMonthStart,
        endZoned: previousMonthEnd
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
      totalCostos: {
        value: parseFloat(currentSnapshot.totalCostos.toFixed(2)),
        variation: parseFloat(calculateDelta(currentSnapshot.totalCostos, previousSnapshot.totalCostos).toFixed(2))
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

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('date', groupBy, timezone);

    const successfulPayments = successfulPaymentStatusCondition();
    const ingresosQuery = `SELECT
       ${dateExpression} as periodo,
       SUM(amount) as total_ingresos
     FROM payments
     WHERE ${successfulPayments.sql}
     AND ${nonTestPaymentCondition()}
     AND date >= ? AND date <= ?
     ${hiddenCondition ? `AND contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})` : ''}
     GROUP BY periodo
     ORDER BY periodo`;
    const ingresosParams = [...successfulPayments.params, range.startUtc, range.endUtc];

    const gastosQuery = `SELECT
       ${dateExpression} as periodo,
       SUM(spend) as total_gastos
     FROM meta_ads
     WHERE date >= ? AND date <= ?
     GROUP BY periodo
     ORDER BY periodo`;
    // IMPORTANTE: meta_ads.date es TEXT "YYYY-MM-DD", usar startZoned.toISODate()
    const gastosParams = [range.startZoned.toISODate(), range.endZoned.toISODate()];

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

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Agrupar por mes con timezone dinámico
    const monthExpression = getGroupExpression('i.date', 'month', timezone);

    const successfulPayments = successfulPaymentStatusCondition();
    const query = `
      SELECT
        ${monthExpression} as periodo,
        COALESCE(SUM(i.amount), 0) as ingresos,
        COALESCE(SUM(g.spend), 0) as gastos
      FROM (
        SELECT date, amount FROM payments WHERE ${successfulPayments.sql} AND ${nonTestPaymentCondition()} AND date >= ? AND date <= ?
        ${hiddenCondition ? `AND contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})` : ''}
      ) i
      LEFT JOIN (
        SELECT date, spend FROM meta_ads WHERE date >= ? AND date <= ?
      ) g ON ${getGroupExpression('i.date', 'month', timezone)} = ${getGroupExpression('g.date', 'month', timezone)}
      GROUP BY periodo
      ORDER BY periodo
    `;
    // IMPORTANTE: meta_ads.date es TEXT "YYYY-MM-DD", payments.date es DATETIME
    const params = [
      ...successfulPayments.params,
      range.startUtc,
      range.endUtc,
      range.startZoned.toISODate(),
      range.endZoned.toISODate()
    ];

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

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    const conditions = ['total_paid > 0', 'created_at >= $1', 'created_at <= $2'];
    if (hiddenCondition) conditions.push(hiddenCondition);

    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(*) as total
      FROM contacts
      WHERE ${conditions.join(' AND ')}
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [range.startUtc, range.endUtc];

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

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('started_at', groupBy, timezone);

    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(DISTINCT visitor_id) as total
      FROM sessions
      WHERE started_at >= $1 AND started_at <= $2
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [range.startUtc, range.endUtc];

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

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    const conditions = ['created_at >= $1', 'created_at <= $2'];
    if (hiddenCondition) conditions.push(hiddenCondition);

    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(*) as total
      FROM contacts
      WHERE ${conditions.join(' AND ')}
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [range.startUtc, range.endUtc];

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
    const timezone = range.appliedTimezone;
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

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

    const contactsQuery = `
      SELECT
        id as contact_id,
        ${dateExpression} as periodo
      FROM contacts
      WHERE created_at >= $1 AND created_at <= $2
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    `;

    const contactsRaw = await db.all(contactsQuery, [range.startUtc, range.endUtc]);

    // PASO 4: Agrupar contactos con citas por periodo (fecha de creación)
    const periodMap = {};

    contactsRaw.forEach(contact => {
      if (contactsWithAppointments.has(contact.contact_id)) {
        const periodKey = contact.periodo;

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
 * Obtiene datos de asistencias por periodo.
 * IMPORTANTE: Cuenta contactos ÚNICOS con asistencia, agrupados por fecha de creación del contacto.
 * La fecha de asistencia no se usa para esta gráfica porque aquí medimos atribución.
 */
export const getAttendancesData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const dateExpression = getGroupExpression('c.created_at', groupBy, timezone);

    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const attributionCalendarIds = await getAttributionCalendarIds();
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
      config?.location_id,
      config?.api_token,
      attributionCalendarIds
    );

    if (contactsWithAttendances.size === 0) {
      return res.json([]);
    }

    const conditions = ['c.created_at >= $1', 'c.created_at <= $2'];
    if (hiddenCondition) conditions.push(hiddenCondition);

    const contactsQuery = `
      SELECT
        c.id as contact_id,
        ${dateExpression} as periodo
      FROM contacts c
      WHERE ${conditions.join(' AND ')}
    `;

    const contactsRaw = await db.all(contactsQuery, [range.startUtc, range.endUtc]);
    const periodMap = {};

    contactsRaw.forEach(contact => {
      if (!contactsWithAttendances.has(contact.contact_id)) return;

      if (!periodMap[contact.periodo]) {
        periodMap[contact.periodo] = new Set();
      }

      periodMap[contact.periodo].add(contact.contact_id);
    });

    const attendancesData = Object.keys(periodMap)
      .sort()
      .map(periodo => ({
        label: periodo,
        value: periodMap[periodo].size
      }));

    res.json(attendancesData);
  } catch (error) {
    logger.error(`Error en getAttendancesData: ${error.message}`);
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

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('date', groupBy, timezone);

    const successfulPayments = successfulPaymentStatusCondition();
    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(*) as total
      FROM payments
      WHERE ${successfulPayments.sql}
      AND ${nonTestPaymentCondition()}
      AND date >= ? AND date <= ?
      ${hiddenCondition ? `AND contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})` : ''}
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [...successfulPayments.params, range.startUtc, range.endUtc];

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

    // Obtener tamaño actual de la BD PostgreSQL
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
    const { startDate, endDate, includeWeb = '1', includeWhatsapp = '1' } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const shouldIncludeWeb = String(includeWeb) !== '0'
    const shouldIncludeWhatsapp = String(includeWhatsapp) !== '0'

    // Cada visitante web cuenta una sola vez. Tomamos su primera sesión del rango,
    // igual que hacía este endpoint antes, y después sumamos conversaciones de WhatsApp.
    const query = `
      SELECT
        visitor_id,
        referrer_url,
        site_source_name,
        utm_source,
        source_platform
      FROM (
        SELECT
          visitor_id,
          referrer_url,
          site_source_name,
          utm_source,
          source_platform,
          ROW_NUMBER() OVER (
            PARTITION BY visitor_id
            ORDER BY started_at ASC, created_at ASC, id ASC
          ) as source_rank
        FROM sessions
        WHERE started_at >= ? AND started_at <= ?
          AND visitor_id IS NOT NULL
          AND visitor_id != ''
      )
      WHERE source_rank = 1
    `
    const params = [range.startUtc, range.endUtc]

    const sessions = shouldIncludeWeb ? await db.all(query, params) : []

    const sourcesMap = new Map()
    sessions.forEach(session => {
      const sourceName = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })

      sourcesMap.set(sourceName, (sourcesMap.get(sourceName) || 0) + 1)
    })

    if (shouldIncludeWhatsapp) {
      const whatsappSources = await getWhatsAppApiSourceBreakdown(range, { limit: 100 })
      whatsappSources.forEach(({ name, value }) => {
        sourcesMap.set(name, (sourcesMap.get(name) || 0) + value)
      })
    }

    // Mapear colores por plataforma
    const colorMap = {
      'Facebook': '#1877f2',
      'Google': '#4285f4',
      'Instagram': '#c32aa3',
      'Meta Ads': '#0084ff',
      'TikTok': '#ee1d52',
      'Bing': '#00a4ef',
      'Microsoft': '#00a4ef',
      'Twitter': '#1da1f2',
      'LinkedIn': '#0a66c2',
      'YouTube': '#ff0000',
      'Messenger': '#0084ff',
      'WhatsApp': '#25d366',
      'WhatsApp directo': '#25d366',
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

    const data = Array.from(sourcesMap.entries())
      .map(([name, value]) => ({
        name,
        value,
        color: colorMap[name] || '#6b7280'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)

    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error en getTrafficSources: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error al obtener fuentes de tráfico' })
  }
}

/**
 * Desglose por fuente de origen para métricas de citas o conversiones.
 * - appointments: contactos con cita (date_added) dentro del rango.
 * - conversions: contactos cuyo PRIMER pago exitoso cae en el rango (clientes nuevos),
 *   misma definición que la etapa "Clientes" del embudo en vista "Todos".
 * En ambos casos se agrupa por la fuente resuelta del contacto (sesión web + Meta).
 * @param {'appointments'|'conversions'} metric
 * @param {{ startUtc: string, endUtc: string }} range
 * @returns {Promise<Array<{ name: string, value: number }>>}
 */
async function getSourceBreakdownByMetric(metric, range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenConditionContacts = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
  const hiddenConditionC = hiddenConditionContacts ? hiddenConditionContacts.replace(/contacts\./g, 'c.') : ''

  let contactIds = []

  if (metric === 'appointments') {
    const attributionCalendarIds = await getAttributionCalendarIds()
    const conditions = ['a.date_added >= ?', 'a.date_added <= ?', 'a.contact_id IS NOT NULL']
    const params = [range.startUtc, range.endUtc]

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      conditions.push(`a.calendar_id IN (${attributionCalendarIds.map(() => '?').join(', ')})`)
      params.push(...attributionCalendarIds)
    }
    if (hiddenConditionC) conditions.push(hiddenConditionC)

    const rows = await db.all(`
      SELECT DISTINCT a.contact_id AS id
      FROM appointments a
      INNER JOIN contacts c ON c.id = a.contact_id
      WHERE ${conditions.join(' AND ')}
    `, params)
    contactIds = rows.map(row => row.id)
  } else {
    // conversions: clientes nuevos = contactos cuyo primer pago exitoso cae en el rango
    const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')
    const conditions = ['first_p.first_payment_date >= ?', 'first_p.first_payment_date <= ?']
    if (hiddenConditionC) conditions.push(hiddenConditionC)

    const rows = await db.all(`
      SELECT DISTINCT c.id AS id
      FROM contacts c
      INNER JOIN (
        SELECT contact_id, MIN(date) as first_payment_date
        FROM payments
        WHERE LOWER(status) IN (${statusPlaceholders})
          AND ${nonTestPaymentCondition()}
        GROUP BY contact_id
      ) first_p ON first_p.contact_id = c.id
      WHERE ${conditions.join(' AND ')}
    `, [...SUCCESS_PAYMENT_STATUSES, range.startUtc, range.endUtc])
    contactIds = rows.map(row => row.id)
  }

  return getContactSourceBreakdown(contactIds, { limit: 10 })
}

/**
 * Payload unificado de la dona de "Origen" (Dashboard + Analíticas).
 * Devuelve la distribución de tráfico (6 dimensiones por visitantes únicos) y el
 * desglose por fuente de leads, citas y conversiones. El frontend cambia de vista
 * localmente sin volver a pedir datos.
 */
export const getOriginDistribution = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    const [traffic, leadIds, appointments, conversions, whatsappNumbers] = await Promise.all([
      getTrafficDistributions(range),
      getLeadsContactIds(range),
      getSourceBreakdownByMetric('appointments', range),
      getSourceBreakdownByMetric('conversions', range),
      getWhatsAppApiNumberBreakdown(range)
    ])

    const leads = await getContactSourceBreakdown(leadIds, { limit: 10 })

    res.json({
      success: true,
      data: { traffic, leads, appointments, conversions, whatsappNumbers }
    })
  } catch (error) {
    logger.error(`Error en getOriginDistribution: ${error.message}`)
    logger.error(error.stack)
    res.status(500).json({ success: false, error: 'Error al obtener la distribución de origen' })
  }
}

/**
 * Obtiene TODOS los ingresos y gastos (no solo atribuidos)
 * Para el gráfico principal del Dashboard
 */
export const getFinancialOverview = async (req, res) => {
  try {
    const { startDate, endDate, scope = 'all' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const timezone = range.appliedTimezone;
    const isAttributed = scope === 'campaigns' || scope === 'attributed';
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution';

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Usar getGroupExpression() con timezone dinámico.
    // payments.date es timestamp, meta_ads.date es TEXT YYYY-MM-DD.
    const paymentDayExpression = getGroupExpression('date', 'day', timezone);
    const spendDayExpression = getGroupExpression('meta_ads.date', 'day', timezone);

    let revenueQuery = '';
    let revenueParams = [];
    const successfulPayments = successfulPaymentStatusCondition('p');

    if (!useContactAttribution) {
      // Vista "Todos": ingresos por fecha real de pago
      revenueQuery = `
        SELECT
          ${paymentDayExpression.replace(/\bdate\b/g, 'p.date')} as day,
          COALESCE(SUM(p.amount), 0) as revenue
        FROM payments p
        LEFT JOIN contacts c ON c.id = p.contact_id
        WHERE ${successfulPayments.sql}
          AND ${nonTestPaymentCondition('p')}
          AND p.date >= ? AND p.date <= ?
          ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
        GROUP BY day
        ORDER BY day ASC
      `;
      revenueParams = [...successfulPayments.params, range.startUtc, range.endUtc];
    } else {
      // Vista "Al registro" / "Identificados de anuncios": ingresos por fecha de creación del contacto
      revenueQuery = `
        SELECT
          ${getGroupExpression('c.created_at', 'day', timezone)} as day,
          COALESCE(SUM(p.amount), 0) as revenue
        FROM contacts c
        LEFT JOIN payments p
          ON p.contact_id = c.id
          AND ${successfulPayments.sql}
          AND ${nonTestPaymentCondition('p')}
        WHERE c.created_at >= ? AND c.created_at <= ?
          ${isAttributed ? `AND c.attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = c.attribution_ad_id
              AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', timezone)}
          )` : ''}
          ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
        GROUP BY day
        ORDER BY day ASC
      `;
      revenueParams = [...successfulPayments.params, range.startUtc, range.endUtc];
    }

    // Query para TODOS los gastos de publicidad
    const spendQuery = `
      SELECT
        ${spendDayExpression} as day,
        SUM(spend) as spend
      FROM meta_ads
      WHERE date >= ? AND date <= ?
      GROUP BY day
      ORDER BY day ASC
    `;

    // IMPORTANTE: meta_ads.date es TEXT "YYYY-MM-DD", usar toISODate()
    const spendParams = [range.startZoned.toISODate(), range.endZoned.toISODate()];
    const [revenueData, spendData] = await Promise.all([
      db.all(revenueQuery, revenueParams),
      db.all(spendQuery, spendParams)
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
      const visitorsQuery = `
        SELECT COUNT(DISTINCT visitor_id) as count
        FROM sessions
        WHERE started_at >= $1 AND started_at <= $2
      `
      const visitorsParams = [range.startUtc, range.endUtc]

      const visitorsResult = await db.get(visitorsQuery, visitorsParams)
      visitorsCount = parseInt(visitorsResult?.count || 0)
    } else {
      // Vista "Último toque": Solo visitantes que SE CONVIRTIERON en contacto
      // Agrupa por fecha de creación del contacto
      const visitorsQuery = `
        SELECT COUNT(DISTINCT s.visitor_id) as count
        FROM sessions s
        INNER JOIN contacts c ON c.id = s.contact_id
        WHERE c.created_at >= $1 AND c.created_at <= $2
          ${isAttributed ? `AND c.attribution_ad_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM meta_ads ma
            WHERE ma.ad_id = c.attribution_ad_id
              AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone)}
          )` : ''}
      `
      const visitorsParams = [range.startUtc, range.endUtc]

      const visitorsResult = await db.get(visitorsQuery, visitorsParams)
      visitorsCount = parseInt(visitorsResult?.count || 0)
    }

    // ========================================
    // 2. LEADS (según scope)
    // ========================================
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    const conditions = ['created_at >= $1', 'created_at <= $2'];
    if (isAttributed) {
      conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = contacts.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'contacts.created_at', range.appliedTimezone)}
      )`);
    }
    if (hiddenCondition) conditions.push(hiddenCondition);

    const leadsQuery = `
      SELECT COUNT(*) as count
      FROM contacts
      WHERE ${conditions.join(' AND ')}
    `;
    const leadsParams = [range.startUtc, range.endUtc];

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
      const conditions = ['created_at >= $1', 'created_at <= $2'];
      if (isAttributed) {
        conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = contacts.attribution_ad_id
            AND ${metaAdsSameLocalDayCondition('ma.date', 'contacts.created_at', range.appliedTimezone)}
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
    // 4. ASISTENCIAS (siempre por fecha de creación del contacto)
    // ========================================
    const attendanceConditions = ['created_at >= $1', 'created_at <= $2'];
    if (isAttributed) {
      attendanceConditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = contacts.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'contacts.created_at', range.appliedTimezone)}
      )`);
    }
    if (hiddenCondition) attendanceConditions.push(hiddenCondition);

    const contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
      hlConfig?.location_id,
      hlConfig?.api_token,
      attributionCalendarIds
    )
    const attendanceContactsQuery = `
      SELECT id
      FROM contacts
      WHERE ${attendanceConditions.join(' AND ')}
    `;
    const attendanceContactsRaw = await db.all(attendanceContactsQuery, [range.startUtc, range.endUtc]);
    const attendancesCount = attendanceContactsRaw.filter(c => contactsWithAttendances.has(c.id)).length;

    // ========================================
    // 5. CLIENTES NUEVOS (según scope)
    // ========================================
    let customersCount = 0

    if (useContactAttribution) {
      // Vista "Último toque": Contactos creados en el rango con purchases_count > 0
      const conditions = ['purchases_count > 0', 'created_at >= $1', 'created_at <= $2'];
      if (isAttributed) {
        conditions.push(`attribution_ad_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = contacts.attribution_ad_id
            AND ${metaAdsSameLocalDayCondition('ma.date', 'contacts.created_at', range.appliedTimezone)}
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
      // Vista "Todos": Contactos cuyo PRIMER pago está en el rango
      const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',')

      const conditions = ['first_p.first_payment_date >= $' + (SUCCESS_PAYMENT_STATUSES.length + 1),
                         'first_p.first_payment_date <= $' + (SUCCESS_PAYMENT_STATUSES.length + 2)]
      if (hiddenCondition) {
        conditions.push(hiddenCondition.replace(/contacts\./g, 'c.'))
      }

      const firstPaymentQuery = `
        SELECT COUNT(DISTINCT c.id) as count
        FROM contacts c
        INNER JOIN (
          SELECT contact_id, MIN(date) as first_payment_date
          FROM payments
          WHERE LOWER(status) IN (${statusPlaceholders})
          AND ${nonTestPaymentCondition()}
          GROUP BY contact_id
        ) first_p ON first_p.contact_id = c.id
        WHERE ${conditions.join(' AND ')}
      `
      const firstPaymentParams = [...SUCCESS_PAYMENT_STATUSES, range.startUtc, range.endUtc]
      const customersData = await db.get(firstPaymentQuery, firstPaymentParams)
      customersCount = parseInt(customersData?.count || 0)
    }

    // ========================================
    // 6. RESPUESTA
    // ========================================
    const data = [
      { stage: 'Visitantes', value: visitorsCount },
      { stage: labels.leads, value: parseInt(leadsData?.count || 0) },
      { stage: 'Citas', value: appointmentsCount },
      { stage: 'Asistencias', value: attendancesCount },
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
