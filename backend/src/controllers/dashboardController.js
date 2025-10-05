import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { resolveDateRange } from '../utils/dateUtils.js';
import { DateTime } from 'luxon';

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

    if (false) {
      // PostgreSQL usa TO_CHAR
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';

      ingresosQuery = `SELECT
         TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
         SUM(amount) as total_ingresos
       FROM payments
       WHERE status = 'succeeded'
       AND date >= $1 AND date < ($2::date + INTERVAL '1 day')
       GROUP BY periodo
       ORDER BY periodo`;
      ingresosParams = [startDate, endDate];

      gastosQuery = `SELECT
         TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
         SUM(spend) as total_gastos
       FROM meta_ads
       WHERE date >= $1 AND date < ($2::date + INTERVAL '1 day')
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
    if (false) {
      query = `
        SELECT
          TO_CHAR(i.date::timestamp, 'YYYY-MM') as periodo,
          COALESCE(SUM(i.amount), 0) as ingresos,
          COALESCE(SUM(g.spend), 0) as gastos
        FROM (
          SELECT date, amount FROM payments WHERE status = 'succeeded' AND date >= $1 AND date < ($2::date + INTERVAL '1 day')
        ) i
        LEFT JOIN (
          SELECT date, spend FROM meta_ads WHERE date >= $3 AND date < ($4::date + INTERVAL '1 day')
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

    if (false) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(created_at::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE total_paid > 0
        AND created_at >= $1 AND created_at < ($2::date + INTERVAL '1 day')
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

    if (false) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(created_at::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE created_at >= $1 AND created_at < ($2::date + INTERVAL '1 day')
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
 */
export const getAppointmentsData = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    let query;
    let params;

    if (false) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(appointment_date::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE appointment_date IS NOT NULL
        AND appointment_date >= $1 AND appointment_date < ($2::date + INTERVAL '1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [startDate, endDate];
    } else {
      const dateFormat = groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';
      query = `
        SELECT
          strftime(?, appointment_date) as periodo,
          COUNT(*) as total
        FROM contacts
        WHERE appointment_date IS NOT NULL
        AND appointment_date >= ? AND appointment_date < DATE(?, '+1 day')
        GROUP BY periodo
        ORDER BY periodo
      `;
      params = [dateFormat, startDate, endDate];
    }

    const data = await db.all(query, params);

    const appointmentsData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
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

    if (false) {
      const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      query = `
        SELECT
          TO_CHAR(date::timestamp, '${dateFormat}') as periodo,
          COUNT(*) as total
        FROM payments
        WHERE status = 'succeeded'
        AND date >= $1 AND date < ($2::date + INTERVAL '1 day')
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
