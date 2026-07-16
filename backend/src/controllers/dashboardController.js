import { databaseDialect, db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { normalizeToUtcIso, resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js';
import { getGroupExpression } from '../services/analyticsService.js';
import { getManualBusinessExpensesTotalForRange, calculateMonthlyFixedCostForRange } from '../services/manualBusinessExpensesService.js';
import {
  CONTACT_SOURCE_SELECTION_COLUMNS,
  getContactSourceBreakdownForSelection
} from '../services/contactSourceService.js';
import {
  getProjectedOriginSourceDistribution,
  getTrafficDistributions,
  getWhatsAppApiNumberBreakdown
} from '../services/originDistributionService.js';
import { DateTime } from 'luxon';
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js';
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES, successfulPaymentStatusCondition } from '../utils/paymentMode.js';
import { getStorageStatus as getDatabaseStorageStatus } from '../services/notificationsService.js';
import { getVisitorIdentityExpression } from '../services/trackingService.js';
import { buildTransactionListWhere } from '../services/transactionQueryService.js';
import { isContactListProjectionAvailable } from '../services/crmListProjectionService.js';
import { getLocalWhatsAppAnalyticsPhoneNumbers } from '../services/whatsappApiService.js';

const isPostgres = databaseDialect === 'postgres';
const DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT = 5;
const DASHBOARD_ANALYTICS_DEADLINE_MS = 18_000;
const DASHBOARD_INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
];
const DASHBOARD_ATTENDED_APPOINTMENT_STATUSES = ['showed', 'attended', 'completed', 'complete'];

function createDashboardRequestAbortScope(res, { timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onClose = () => {
    if (!res?.writableEnded && !res?.finished) controller.abort();
  };
  const observable = typeof res?.once === 'function';
  if (observable) res.once('close', onClose);
  const deadlineTimer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  deadlineTimer?.unref?.();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      if (observable && typeof res?.off === 'function') res.off('close', onClose);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  };
}

function isDashboardRequestAbort(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

function dashboardAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('La consulta del Dashboard fue cancelada');
  error.name = 'AbortError';
  return error;
}

/**
 * Carril abortable para las lecturas que componen una misma respuesta del
 * Dashboard. Es deliberadamente local al request: limita el pico que genera un
 * usuario sin convertir peticiones de usuarios distintos en una cola global.
 */
export function createDashboardReadLimiter(signal, maxConcurrency = 2) {
  const concurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const entry = queue.shift();
      entry.cleanup();
      if (signal?.aborted) {
        entry.reject(dashboardAbortError(signal));
        continue;
      }

      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          drain();
        });
    }
  };

  return (task) => {
    if (signal?.aborted) return Promise.reject(dashboardAbortError(signal));

    return new Promise((resolve, reject) => {
      const entry = {
        task,
        resolve,
        reject,
        cleanup: () => {}
      };
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        entry.cleanup();
        reject(dashboardAbortError(signal));
      };
      entry.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });

      // AbortSignal no vuelve a emitir un aborto ocurrido entre el primer check
      // y addEventListener(). Cerrar esa carrera evita una promesa encolada eterna.
      if (signal?.aborted) {
        entry.cleanup();
        reject(dashboardAbortError(signal));
        return;
      }

      queue.push(entry);
      drain();
    });
  };
}

const sqlStringList = (values) => values.map(value => `'${value}'`).join(', ');

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

const normalizeDashboardPaymentStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'succeeded' ? 'paid' : normalized;
};

const mapOperationalTransaction = (row) => ({
  id: row.id,
  date: normalizeToUtcIso(row.date || row.created_at, 'UTC'),
  contactId: row.contact_id || undefined,
  contactName: row.contact_name || '',
  email: row.contact_email || '',
  phone: row.contact_phone || '',
  amount: Number(row.amount || 0),
  currency: row.currency || undefined,
  method: row.payment_method || 'other',
  status: normalizeDashboardPaymentStatus(row.status),
  paymentMode: row.payment_mode || 'live',
  paymentProvider: row.payment_provider || 'manual',
  title: row.title || row.description || 'Pago',
  description: row.description || '',
  createdAt: normalizeToUtcIso(row.created_at, 'UTC'),
  updatedAt: normalizeToUtcIso(row.updated_at, 'UTC')
});

const mapOperationalContact = (row) => ({
  id: row.id,
  name: row.full_name || '',
  email: row.email || '',
  phone: row.phone || '',
  created_at: normalizeToUtcIso(row.created_at, 'UTC'),
  ltv: Number(row.total_paid || 0),
  purchases: Number(row.purchases_count || 0),
  attributed: Boolean(row.attribution_ad_id),
  source: row.source || null
});

const mapOperationalAppointment = (row) => ({
  id: row.id,
  title: row.title || '(Sin título)',
  calendarId: row.calendar_id || '',
  locationId: row.location_id || '',
  contactId: row.contact_id || undefined,
  appointmentStatus: row.appointment_status || row.status || 'confirmed',
  status: row.status || row.appointment_status || 'confirmed',
  assignedUserId: row.assigned_user_id || undefined,
  notes: row.notes || '',
  address: row.address || '',
  startTime: normalizeToUtcIso(row.start_time, 'UTC'),
  endTime: normalizeToUtcIso(row.end_time || row.start_time, 'UTC'),
  dateAdded: normalizeToUtcIso(row.date_added || row.start_time, 'UTC'),
  dateUpdated: normalizeToUtcIso(row.date_updated, 'UTC') || undefined
});

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

// (MET-CONSIST) Las métricas de CONTEO ÚNICO (visitantes, citados, asistencias) NO
// se pueden sumar por día para armar un bucket de semana/quincena/trimestre/año: un
// mismo visitante/contacto activo en varios días del bucket se contaría de más frente
// al modal, que hace DISTINCT sobre TODA la ventana. Para que el número del punto de la
// gráfica empate 1:1 con su modal, el frontend manda las fronteras EXACTAS de cada
// bucket (las mismas de buildChartBuckets y las mismas que abre el modal) y aquí
// calculamos el DISTINCT una sola vez por ventana. Las series aditivas (leads, ventas,
// ingresos, gasto) siguen pidiéndose por día y sumándose sin cambio.
const parseChartPeriods = (periodsParam, timezone) => {
  if (!periodsParam) return null;

  let parsed;
  try {
    parsed = typeof periodsParam === 'string' ? JSON.parse(periodsParam) : periodsParam;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const valid = parsed.filter(p => p && p.start && p.end);
  if (valid.length === 0) return null;

  // El timezone ya fue resuelto una sola vez para toda la petición. Así evitamos
  // una lectura de configuración por bucket y conservamos las fronteras del modal.
  const resolved = valid.map((p) => {
    const r = resolveDateRange({ startDate: p.start, endDate: p.end, timezone });
    return {
      label: p.start,
      startUtc: r.startUtc,
      endUtc: r.endUtc
    };
  }).filter(period => period.startUtc && period.endUtc);

  return resolved.length > 0 ? resolved : null;
};

const buildDistinctChartBuckets = (dateColumn, identityExpression, periods) => {
  const params = [];
  const selects = periods.map((period, index) => {
    params.push(period.startUtc, period.endUtc);
    return `COUNT(DISTINCT CASE
      WHEN ${dateColumn} >= ? AND ${dateColumn} <= ? THEN ${identityExpression}
    END) AS b${index}`;
  });
  const overallStart = periods.reduce(
    (minimum, period) => (period.startUtc < minimum ? period.startUtc : minimum),
    periods[0].startUtc
  );
  const overallEnd = periods.reduce(
    (maximum, period) => (period.endUtc > maximum ? period.endUtc : maximum),
    periods[0].endUtc
  );

  return { selects, params, overallStart, overallEnd };
};

const mapDistinctChartBuckets = (row, periods) => periods.map((period, index) => ({
  label: period.label,
  value: Number(row?.[`b${index}`] || 0)
}));

const dashboardCalendarCondition = (alias, calendarIds) => {
  if (!calendarIds?.length) return '';
  return `${alias}.calendar_id IN (${calendarIds.map(() => '?').join(', ')})`;
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

const computeFinancialSnapshot = async (
  range,
  signal,
  hiddenFiltersOverride = null,
  runRead = (task) => task()
) => {
  // Obtener filtro de contactos ocultos
  const hiddenFilters = hiddenFiltersOverride || await getHiddenContactFilters({ signal });
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

  // Ingresos, reembolsos y ticket promedio comparten exactamente el mismo
  // universo de pagos. Hacer tres recorridos secuenciales multiplicaba la
  // latencia del Dashboard conforme crecia la tabla; una sola pasada indexada
  // produce los tres valores.
  const successfulPayments = successfulPaymentStatusCondition('p');
  const { filters: dateFilters, params: dateParams } = buildDateFilters(range);
  const paymentBaseFilters = [
    nonTestPaymentCondition('p'),
    ...dateFilters.map(filter => filter.replace(/\bdate\b/g, 'p.date'))
  ];
  if (hiddenCondition) {
    paymentBaseFilters.push(`p.contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})`);
  }

  const paymentAggregateQuery = `
    SELECT
      COALESCE(SUM(CASE WHEN ${successfulPayments.sql} THEN p.amount ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN p.status = ? THEN p.amount ELSE 0 END), 0) AS refunds,
      COALESCE(AVG(CASE WHEN ${successfulPayments.sql} THEN p.amount END), 0) AS avg_payment
    FROM payments p
    WHERE ${paymentBaseFilters.join(' AND ')}
  `;
  const paymentAggregateParams = [
    ...successfulPayments.params,
    'refunded',
    ...successfulPayments.params,
    ...dateParams
  ];

  const gastosFilters = [];
  const gastosParams = [];
  const { filters: spendDateFilters, params: spendDateParams } = buildMetaAdsDateFilters(range);
  if (spendDateFilters.length) {
    gastosFilters.push(...spendDateFilters);
    gastosParams.push(...spendDateParams);
  }

  const gastosWhere = gastosFilters.length ? `WHERE ${gastosFilters.join(' AND ')}` : '';
  const gastosQuery = `SELECT COALESCE(SUM(spend), 0) as total FROM meta_ads ${gastosWhere}`;

  // (RPT-001) Rango local para prorratear costos fijos mensuales por longitud del rango
  const localDateRange = getLocalDateRange(range);

  const [paymentAggregateRow, gastosRow, costs, manualBusinessExpenses] = await Promise.all([
    runRead(() => db.get(paymentAggregateQuery, paymentAggregateParams, { signal })),
    runRead(() => db.get(gastosQuery, gastosParams, { signal })),
    runRead(() => db.all('SELECT * FROM costs WHERE is_active = 1', [], { signal })).catch((error) => {
      if (isDashboardRequestAbort(error, signal)) throw error;
      logger.warn(`Error calculando costos desde tabla costs (no se aplicará costo automático): ${error.message}`);
      return [];
    }),
    localDateRange
      ? runRead(() => getManualBusinessExpensesTotalForRange(localDateRange, { signal })).catch((error) => {
        if (isDashboardRequestAbort(error, signal)) throw error;
        logger.warn('Error calculando costos variables manuales:', error.message);
        return 0;
      })
      : Promise.resolve(0)
  ]);

  const ingresosNetos = parseFloat(paymentAggregateRow?.revenue || 0);
  const reembolsos = parseFloat(paymentAggregateRow?.refunds || 0);
  const ltvPromedio = parseFloat(paymentAggregateRow?.avg_payment || 0);
  const gastosPublicidad = parseFloat(gastosRow?.total || 0);
  const gananciaBruta = ingresosNetos - gastosPublicidad;
  const roas = gastosPublicidad > 0 ? ingresosNetos / gastosPublicidad : 0;

  // Calcular costos dinámicamente desde la tabla costs
  let totalCostos = 0;
  for (const cost of costs) {
    let amount = 0;

    if (cost.calculation_type === 'percentage') {
      amount = cost.applies_to === 'profit'
        ? (gananciaBruta * cost.value) / 100
        : (ingresosNetos * cost.value) / 100;
    } else if (cost.calculation_type === 'fixed') {
      amount = localDateRange
        ? calculateMonthlyFixedCostForRange(localDateRange, cost.value)
        : cost.value;
    }

    totalCostos += amount;
  }
  totalCostos += Number(manualBusinessExpenses || 0);

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
 * Devuelve únicamente las filas necesarias para las tres listas operativas del
 * Dashboard. Es deliberadamente local: no sincroniza Stripe, HighLevel, Google
 * Calendar ni ningún otro proveedor durante este GET.
 */
export const getOperationalSnapshot = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate (formato: YYYY-MM-DD)'
      });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal });
    const hiddenContactCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const visibleLinkedContactCondition = hiddenContactCondition
      ? `(${hiddenContactCondition} OR c.id IS NULL)`
      : '1 = 1';
    const paymentListWhere = buildTransactionListWhere({
      range,
      hiddenCondition: hiddenContactCondition,
      includeStatus: false,
      paymentAlias: 'p',
      contactAlias: 'c',
      extraContactConditions: [nonTestPaymentCondition('p')]
    });

    const paymentsQuery = `
      SELECT
        p.id,
        p.contact_id,
        p.amount,
        p.currency,
        p.status,
        p.payment_method,
        p.payment_mode,
        p.payment_provider,
        p.title,
        p.description,
        p.date,
        p.created_at,
        p.updated_at,
        c.full_name AS contact_name,
        c.email AS contact_email,
        c.phone AS contact_phone
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      ${paymentListWhere.whereClause}
      ORDER BY p.date DESC, p.created_at DESC, p.id DESC
      LIMIT ${DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT}
    `;

    const contactsQuery = `
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        c.created_at,
        c.total_paid,
        c.purchases_count,
        c.attribution_ad_id,
        c.source
      FROM contacts c
      WHERE c.created_at >= ?
        AND c.created_at <= ?
        AND c.deleted_at IS NULL
        ${hiddenContactCondition ? `AND ${hiddenContactCondition}` : ''}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT}
    `;

    const appointmentsQuery = `
      SELECT
        a.id,
        a.calendar_id,
        a.contact_id,
        a.location_id,
        a.title,
        a.status,
        a.appointment_status,
        a.assigned_user_id,
        a.notes,
        a.address,
        a.start_time,
        a.end_time,
        a.date_added,
        a.date_updated
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id
      LEFT JOIN calendars cal ON cal.id = a.calendar_id
      WHERE a.start_time >= ?
        AND a.start_time <= ?
        AND a.deleted_at IS NULL
        AND COALESCE(a.sync_status, '') != 'pending_delete'
        AND (cal.id IS NULL OR COALESCE(cal.is_active, 1) != 0)
        AND ${visibleLinkedContactCondition}
      ORDER BY a.start_time DESC, a.id DESC
      LIMIT ${DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT}
    `;

    const runRead = createDashboardReadLimiter(requestScope.signal, 2);
    const [paymentRows, contactRows, appointmentRows] = await Promise.all([
      runRead(() => db.all(paymentsQuery, paymentListWhere.params, { signal: requestScope.signal })),
      runRead(() => db.all(contactsQuery, [range.startUtc, range.endUtc], { signal: requestScope.signal })),
      runRead(() => db.all(appointmentsQuery, [range.startUtc, range.endUtc], { signal: requestScope.signal }))
    ]);

    if (requestScope.signal.aborted || res.writableEnded || res.finished) return;

    res.json({
      success: true,
      data: {
        transactions: paymentRows.map(mapOperationalTransaction),
        contacts: contactRows.map(mapOperationalContact),
        appointments: appointmentRows.map(mapOperationalAppointment)
      },
      range: {
        start: range.startUtc,
        end: range.endUtc,
        timezone: range.appliedTimezone
      },
      limit: DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT
    });
  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getOperationalSnapshot: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el resumen operativo del dashboard'
    });
  } finally {
    requestScope.cleanup();
  }
};

function buildPreviousDashboardRange(range) {
  const spanDays = range.startZoned && range.endZoned
    ? Math.max(Math.round(range.endZoned.diff(range.startZoned, 'days').days) + 1, 1)
    : null;

  if (spanDays) {
    const prevEnd = range.startZoned.minus({ days: 1 }).endOf('day');
    const prevStart = prevEnd.minus({ days: spanDays - 1 }).startOf('day');
    return {
      startUtc: prevStart.toUTC().toISO({ suppressMilliseconds: false }),
      endUtc: prevEnd.toUTC().toISO({ suppressMilliseconds: false }),
      appliedTimezone: range.appliedTimezone,
      isFiltered: true,
      startZoned: prevStart,
      endZoned: prevEnd
    };
  }

  const zone = range.appliedTimezone;
  const nowZoned = DateTime.now().setZone(zone);
  const currentMonthStart = nowZoned.startOf('month');
  const previousMonthStart = currentMonthStart.minus({ months: 1 }).startOf('month');
  const previousMonthEnd = currentMonthStart.minus({ days: 1 }).endOf('day');
  return {
    startUtc: previousMonthStart.toUTC().toISO({ suppressMilliseconds: false }),
    endUtc: previousMonthEnd.toUTC().toISO({ suppressMilliseconds: false }),
    appliedTimezone: zone,
    isFiltered: true,
    startZoned: previousMonthStart,
    endZoned: previousMonthEnd
  };
}

async function computeDashboardMetrics(range, signal, { hiddenFilters } = {}) {
  const previousRange = buildPreviousDashboardRange(range);
  const sharedHiddenFilters = hiddenFilters || await getHiddenContactFilters({ signal });
  // current y previous deben compartir EL MISMO carril. Crear un limitador por
  // periodo volvería a permitir cuatro (o más) lecturas simultáneas.
  const runRead = createDashboardReadLimiter(signal, 2);
  const [currentSnapshot, previousSnapshot] = await Promise.all([
    computeFinancialSnapshot(range, signal, sharedHiddenFilters, runRead),
    computeFinancialSnapshot(previousRange, signal, sharedHiddenFilters, runRead)
  ]);

  return {
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
}

/**
 * Calcula y devuelve los KPIs principales del dashboard
 */
export const getMetrics = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate (formato: YYYY-MM-DD)'
      });
    }

    logger.info(`Calculando métricas del dashboard desde ${startDate} hasta ${endDate}`);
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const metrics = await computeDashboardMetrics(range, requestScope.signal);
    logger.info(`Métricas calculadas: ROAS ${metrics.roas.value}, Ganancia Neta ${metrics.gananciaNeta.value}`);

    if (!requestScope.signal.aborted) res.json(metrics);
  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getMetrics: ${error.message}`);
    res.status(500).json({ success: false, error: 'Error al calcular las métricas' });
  } finally {
    requestScope.cleanup();
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

    // (RPT-009) Placeholders posicionales SQLite-compatibles: el adaptador de db
    // convierte '?' a $1/$2 solo en Postgres. Hardcodear $1/$2 rompe en SQLite.
    const conditions = ['total_paid > 0', 'created_at >= ?', 'created_at <= ?'];
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
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, groupBy = 'day', periods: periodsParam } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    const identityExpression = getVisitorIdentityExpression();
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const timezone = range.appliedTimezone;

    // Ruta por bucket exacto (semana/quincena/trimestre/año): un COUNT(DISTINCT) por
    // ventana, calculado en una sola query con agregación condicional. Empata el modal.
    const periods = parseChartPeriods(periodsParam, timezone);
    if (periods) {
      const buckets = buildDistinctChartBuckets('started_at', identityExpression, periods);
      const bucketParams = [...buckets.params, buckets.overallStart, buckets.overallEnd];

      const bucketQuery = `
        SELECT ${buckets.selects.join(', ')}
        FROM sessions
        WHERE started_at >= ? AND started_at <= ?
      `;

      const row = await db.get(bucketQuery, bucketParams, { signal: requestScope.signal });
      if (requestScope.signal.aborted) return;
      return res.json(mapDistinctChartBuckets(row, periods));
    }

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('started_at', groupBy, timezone);

    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(DISTINCT ${identityExpression}) as total
      FROM sessions
      WHERE started_at >= ? AND started_at <= ?
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [range.startUtc, range.endUtc];

    const data = await db.all(query, params, { signal: requestScope.signal });

    const visitorsData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    if (!requestScope.signal.aborted) res.json(visitorsData);

  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getVisitorsData: ${error.message}`);
    res.json([]);
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene datos de leads (todos los contactos nuevos) por periodo
 */
export const getLeadsData = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const timezone = range.appliedTimezone;

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('created_at', groupBy, timezone);

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal });
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);

    // (RPT-009) '?' en vez de $1/$2 para ser compatible con SQLite y Postgres.
    const conditions = ['created_at >= ?', 'created_at <= ?'];
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

    const data = await db.all(query, params, { signal: requestScope.signal });

    const leadsData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    if (!requestScope.signal.aborted) res.json(leadsData);

  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getLeadsData: ${error.message}`);
    res.json([]);
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene datos de citas programadas por periodo
 * En scope "all" agrupa por date_added; en atribución agrupa por created_at del contacto.
 * En ambos casos cuenta contactos únicos dentro de cada bucket.
 *
 * Todas las variantes se resuelven con agregación local acotada al rango. Este
 * GET nunca sincroniza calendarios ni descarga historiales de proveedores.
 */
export const getAppointmentsData = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, groupBy = 'day', scope = 'all', periods: periodsParam } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const timezone = range.appliedTimezone;
    const periods = parseChartPeriods(periodsParam, timezone);
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution';
    const isAttributed = scope === 'campaigns' || scope === 'attributed';
    const [configuredCalendarIds, hiddenFilters] = await Promise.all([
      getAttributionCalendarIds({ signal: requestScope.signal }),
      getHiddenContactFilters({ signal: requestScope.signal })
    ]);
    const attributionCalendarIds = Array.isArray(configuredCalendarIds) ? configuredCalendarIds : [];
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const calendarCondition = dashboardCalendarCondition('a', attributionCalendarIds);

    if (!useContactAttribution) {
      const baseConditions = ['a.contact_id IS NOT NULL'];
      if (hiddenConditionC) baseConditions.push(`(c.id IS NULL OR ${hiddenConditionC})`);
      if (calendarCondition) baseConditions.push(calendarCondition);
      if (periods) {
        const buckets = buildDistinctChartBuckets('a.date_added', 'a.contact_id', periods);
        const row = await db.get(`
          SELECT ${buckets.selects.join(', ')}
          FROM appointments a
          LEFT JOIN contacts c ON c.id = a.contact_id
          WHERE a.date_added >= ? AND a.date_added <= ?
            AND ${baseConditions.join(' AND ')}
        `, [
          ...buckets.params,
          buckets.overallStart,
          buckets.overallEnd,
          ...attributionCalendarIds
        ], { signal: requestScope.signal });
        if (requestScope.signal.aborted) return;
        return res.json(mapDistinctChartBuckets(row, periods));
      }

      const dateExpression = getGroupExpression('a.date_added', groupBy, timezone);
      const rows = await db.all(`
        SELECT ${dateExpression} AS periodo, COUNT(DISTINCT a.contact_id) AS total
        FROM appointments a
        LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.date_added >= ? AND a.date_added <= ?
          AND ${baseConditions.join(' AND ')}
        GROUP BY periodo
        ORDER BY periodo
      `, [range.startUtc, range.endUtc, ...attributionCalendarIds], { signal: requestScope.signal });
      if (requestScope.signal.aborted) return;
      return res.json(rows.map(row => ({ label: row.periodo, value: Number(row.total || 0) })));
    }

    const activeAppointmentConditions = [
      'a.contact_id = c.id',
      `LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${sqlStringList(DASHBOARD_INACTIVE_APPOINTMENT_STATUSES)})`
    ];
    if (calendarCondition) activeAppointmentConditions.push(calendarCondition);
    const contactConditions = [];
    if (hiddenConditionC) contactConditions.push(hiddenConditionC);
    if (isAttributed) {
      contactConditions.push(`c.attribution_ad_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', timezone)}
      )`);
    }
    contactConditions.push(`EXISTS (
      SELECT 1 FROM appointments a
      WHERE ${activeAppointmentConditions.join(' AND ')}
    )`);

    if (periods) {
      const buckets = buildDistinctChartBuckets('c.created_at', 'c.id', periods);
      const row = await db.get(`
        SELECT ${buckets.selects.join(', ')}
        FROM contacts c
        WHERE c.created_at >= ? AND c.created_at <= ?
          AND ${contactConditions.join(' AND ')}
      `, [
        ...buckets.params,
        buckets.overallStart,
        buckets.overallEnd,
        ...attributionCalendarIds
      ], { signal: requestScope.signal });
      if (requestScope.signal.aborted) return;
      return res.json(mapDistinctChartBuckets(row, periods));
    }

    const dateExpression = getGroupExpression('c.created_at', groupBy, timezone);
    const rows = await db.all(`
      SELECT ${dateExpression} AS periodo, COUNT(DISTINCT c.id) AS total
      FROM contacts c
      WHERE c.created_at >= ? AND c.created_at <= ?
        AND ${contactConditions.join(' AND ')}
      GROUP BY periodo
      ORDER BY periodo
    `, [range.startUtc, range.endUtc, ...attributionCalendarIds], { signal: requestScope.signal });
    if (!requestScope.signal.aborted) {
      res.json(rows.map(row => ({ label: row.periodo, value: Number(row.total || 0) })));
    }

  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getAppointmentsData: ${error.message}`);
    res.json([]);
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene datos de asistencias por periodo.
 * IMPORTANTE: Cuenta contactos ÚNICOS con asistencia, agrupados por fecha de creación del contacto.
 * La fecha de asistencia no se usa para esta gráfica porque aquí medimos atribución.
 */
export const getAttendancesData = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, groupBy = 'day', scope = 'all', periods: periodsParam } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const timezone = range.appliedTimezone;
    const periods = parseChartPeriods(periodsParam, timezone);
    const isAttributed = scope === 'campaigns' || scope === 'attributed';
    const [hiddenFilters, configuredCalendarIds] = await Promise.all([
      getHiddenContactFilters({ signal: requestScope.signal }),
      getAttributionCalendarIds({ signal: requestScope.signal })
    ]);
    const attributionCalendarIds = Array.isArray(configuredCalendarIds) ? configuredCalendarIds : [];
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const attendanceAppointmentConditions = [
      'attended_a.contact_id = c.id',
      `LOWER(COALESCE(attended_a.appointment_status, attended_a.status, '')) IN (${sqlStringList(DASHBOARD_ATTENDED_APPOINTMENT_STATUSES)})`
    ];
    const calendarCondition = dashboardCalendarCondition('attended_a', attributionCalendarIds);
    if (calendarCondition) attendanceAppointmentConditions.push(calendarCondition);

    const contactConditions = [];
    if (hiddenConditionC) contactConditions.push(hiddenConditionC);
    if (isAttributed) {
      contactConditions.push(`c.attribution_ad_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', timezone)}
      )`);
    }
    contactConditions.push(`(
      COALESCE(c.purchases_count, 0) > 0
      OR COALESCE(c.total_paid, 0) > 0
      OR EXISTS (
        SELECT 1 FROM appointment_attendance_signals aas
        WHERE aas.contact_id = c.id
      )
      OR EXISTS (
        SELECT 1 FROM appointments attended_a
        WHERE ${attendanceAppointmentConditions.join(' AND ')}
      )
    )`);

    if (periods) {
      const buckets = buildDistinctChartBuckets('c.created_at', 'c.id', periods);
      const row = await db.get(`
        SELECT ${buckets.selects.join(', ')}
        FROM contacts c
        WHERE c.created_at >= ? AND c.created_at <= ?
          AND ${contactConditions.join(' AND ')}
      `, [
        ...buckets.params,
        buckets.overallStart,
        buckets.overallEnd,
        ...attributionCalendarIds
      ], { signal: requestScope.signal });
      if (requestScope.signal.aborted) return;
      return res.json(mapDistinctChartBuckets(row, periods));
    }

    const dateExpression = getGroupExpression('c.created_at', groupBy, timezone);
    const rows = await db.all(`
      SELECT ${dateExpression} AS periodo, COUNT(DISTINCT c.id) AS total
      FROM contacts c
      WHERE c.created_at >= ? AND c.created_at <= ?
        AND ${contactConditions.join(' AND ')}
      GROUP BY periodo
      ORDER BY periodo
    `, [range.startUtc, range.endUtc, ...attributionCalendarIds], { signal: requestScope.signal });

    if (!requestScope.signal.aborted) {
      res.json(rows.map(row => ({ label: row.periodo, value: Number(row.total || 0) })));
    }
  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getAttendancesData: ${error.message}`);
    res.json([]);
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene datos de ventas (pagos exitosos) por periodo
 */
export const getSalesData = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json([]);
    }

    // Obtener timezone dinámico de HighLevel
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const timezone = range.appliedTimezone;

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal });
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);

    // Usar getGroupExpression() con timezone dinámico
    const dateExpression = getGroupExpression('date', groupBy, timezone);

    const successfulPayments = successfulPaymentStatusCondition();
    // (MET-CONSIST) Contar CLIENTES únicos (no filas de pago): el modal de este punto
    // ("Clientes que pagaron", buildContactsList type='sales') lista contactos DISTINCT.
    // Con COUNT(*) un contacto con 2 pagos en el mismo bucket inflaba el número vs el modal.
    const query = `
      SELECT
        ${dateExpression} as periodo,
        COUNT(DISTINCT contact_id) as total
      FROM payments
      WHERE ${successfulPayments.sql}
      AND ${nonTestPaymentCondition()}
      AND date >= ? AND date <= ?
      ${hiddenCondition ? `AND contact_id IN (SELECT c.id FROM contacts c WHERE ${hiddenCondition})` : ''}
      GROUP BY periodo
      ORDER BY periodo
    `;
    const params = [...successfulPayments.params, range.startUtc, range.endUtc];

    const data = await db.all(query, params, { signal: requestScope.signal });

    const salesData = data.map(row => ({
      label: row.periodo,
      value: parseInt(row.total)
    }));

    if (!requestScope.signal.aborted) res.json(salesData);

  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getSalesData: ${error.message}`);
    res.json([]);
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene el estado del storage de la base de datos
 */
export const getStorageStatus = async (req, res) => {
  try {
    const WARNING_THRESHOLD = 0.8; // Alertar al 80%

    // Cálculo compartido con notificaciones: soporta PostgreSQL y SQLite
    const storage = await getDatabaseStorageStatus();

    const percentUsed = storage.percentUsed;
    const needsAttention = percentUsed >= WARNING_THRESHOLD * 100;

    res.json({
      sizeGB: parseFloat(storage.sizeGB.toFixed(2)),
      sizePretty: storage.sizePretty,
      limitGB: storage.limitGB,
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
  const requestScope = createDashboardRequestAbortScope(res, {
    timeoutMs: DASHBOARD_ANALYTICS_DEADLINE_MS
  })
  try {
    const { startDate, endDate, includeWeb = '1', includeWhatsapp = '1' } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const range = await resolveDateRangeWithGHLTimezone({
      startDate,
      endDate,
      signal: requestScope.signal
    })
    const shouldIncludeWeb = String(includeWeb) !== '0'
    const shouldIncludeWhatsapp = String(includeWhatsapp) !== '0'

    const hiddenFilters = shouldIncludeWhatsapp
      ? await getHiddenContactFilters({ signal: requestScope.signal })
      : []
    const traffic = await getTrafficDistributions(range, {
      includeWeb: shouldIncludeWeb,
      includeWhatsapp: shouldIncludeWhatsapp,
      hiddenFilters,
      signal: requestScope.signal
    })

    if (requestScope.timedOut) {
      const deadlineError = new Error('Las fuentes de tráfico excedieron el presupuesto de ejecución')
      deadlineError.code = 'dashboard_traffic_sources_deadline'
      throw deadlineError
    }
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return

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

    const data = traffic.sources
      .map(({ name, value }) => ({
        name,
        value,
        color: colorMap[name] || '#6b7280'
      }))

    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (!res.writableEnded && !res.finished) {
        res.set?.('Retry-After', '3')
        res.status(503).json({
          success: false,
          error: 'Las fuentes de tráfico siguen procesándose. Reintenta en unos segundos.',
          retryable: true
        })
      }
      return
    }
    if (isDashboardRequestAbort(error, requestScope.signal)) return
    logger.error(`Error en getTrafficSources: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error al obtener fuentes de tráfico' })
  } finally {
    requestScope.cleanup()
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
async function getSourceBreakdownByMetric(
  metric,
  range,
  { hiddenFilters = [], attributionCalendarIds = null, signal } = {}
) {
  const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false)

  if (metric === 'leads') {
    return getContactSourceBreakdownForSelection({
      selectionSql: `
        SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}
        FROM contacts c
        WHERE c.created_at >= ? AND c.created_at <= ?
          ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
      `,
      params: [range.startUtc, range.endUtc],
      limit: 10,
      signal
    })
  }

  if (metric === 'appointments') {
    const appointmentConditions = [
      'a.contact_id = c.id',
      'a.date_added >= ?',
      'a.date_added <= ?'
    ]
    const params = [range.startUtc, range.endUtc]

    if (attributionCalendarIds?.length) {
      appointmentConditions.push(`a.calendar_id IN (${attributionCalendarIds.map(() => '?').join(', ')})`)
      params.push(...attributionCalendarIds)
    }

    return getContactSourceBreakdownForSelection({
      selectionSql: `
        SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}
        FROM contacts c
        WHERE ${hiddenConditionC ? `${hiddenConditionC} AND` : ''}
          EXISTS (
            SELECT 1
            FROM appointments a
            WHERE ${appointmentConditions.join(' AND ')}
          )
      `,
      params,
      limit: 10,
      signal
    })
  }

  // conversions: clientes nuevos = contactos cuyo primer pago exitoso cae en el rango.
  const useProjectedFirstPayment = await isContactListProjectionAvailable()
  const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')
  const firstPaymentRelation = useProjectedFirstPayment
    ? 'contact_list_activity first_p'
    : `(
        SELECT contact_id, MIN(date) AS first_payment_date
        FROM payments
        WHERE LOWER(status) IN (${statusPlaceholders})
          AND ${nonTestPaymentCondition()}
        GROUP BY contact_id
      ) first_p`
  return getContactSourceBreakdownForSelection({
    selectionSql: `
      SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}
      FROM contacts c
      INNER JOIN ${firstPaymentRelation} ON first_p.contact_id = c.id
      WHERE first_p.first_payment_date >= ? AND first_p.first_payment_date <= ?
        ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
    `,
    params: [
      ...(useProjectedFirstPayment ? [] : SUCCESS_PAYMENT_STATUSES),
      range.startUtc,
      range.endUtc
    ],
    limit: 10,
    signal
  })
}

/**
 * Payload unificado de la dona de "Origen" (Dashboard + Analíticas).
 * Por compatibilidad puede devolver las seis dimensiones y los desgloses de
 * leads/citas/conversiones. Las cards web piden una sola dimensión y omiten los
 * desgloses que no renderizan, para no escanear la misma tabla seis veces.
 */
const ORIGIN_TRAFFIC_DIMENSIONS = new Set(['sources', 'platforms', 'devices', 'placements', 'browsers', 'os'])

async function computeOriginDistribution(range, {
  includeWeb = true,
  includeWhatsapp = true,
  dimension = null,
  includeBreakdowns = true,
  includePhoneBreakdown = false,
  hiddenFilters,
  attributionCalendarIds,
  signal
} = {}) {
  // Estas lecturas son pequeñas pero comparten el mismo pool que los agregados
  // de abajo. Resolverlas en secuencia evita sumar conexiones justo cuando la
  // base está bajo presión.
  const needsHiddenFilters = includeBreakdowns || includePhoneBreakdown || (
    includeWhatsapp && (!dimension || dimension === 'sources' || dimension === 'platforms')
  );
  const resolvedHiddenFilters = hiddenFilters || (
    needsHiddenFilters ? await getHiddenContactFilters({ signal }) : []
  );
  const resolvedAttributionCalendarIds = includeBreakdowns
    ? (attributionCalendarIds || await getAttributionCalendarIds({ signal }))
    : [];

  // La carga lazy del desglose por teléfono apaga ambas fuentes. No tiene
  // sentido construir CTEs vacíos sobre sesiones/mensajes antes de consultar
  // su read model dedicado.
  if (!includeBreakdowns && !includeWeb && !includeWhatsapp) {
    const whatsappNumbers = includePhoneBreakdown
      ? await getWhatsAppApiNumberBreakdown(range, {
          hiddenFilters: resolvedHiddenFilters,
          signal
        })
      : [];
    return {
      traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
      leads: [],
      appointments: [],
      conversions: [],
      whatsappNumbers
    };
  }

  // Fast path exacto de la dona visible en Edge. Mantenerlo explícito evita
  // ampliar este cutover a breakdowns/contactos/teléfonos que tienen contratos
  // y read models distintos.
  if (!includeBreakdowns && includeWeb && includeWhatsapp && dimension === 'sources') {
    const projected = await getProjectedOriginSourceDistribution(range, {
      hiddenFilters: resolvedHiddenFilters,
      signal
    });
    const whatsappNumbers = includePhoneBreakdown
      ? await getWhatsAppApiNumberBreakdown(range, {
          hiddenFilters: resolvedHiddenFilters,
          signal
        })
      : [];
    return {
      traffic: projected.traffic,
      leads: [],
      appointments: [],
      conversions: [],
      whatsappNumbers,
      performance: projected.performance
    };
  }

  // El endpoint anterior lanzaba cinco trabajos y tres copias del cálculo de
  // atribución al mismo tiempo. En instalaciones pequeñas eso agotaba el pool y
  // PostgreSQL terminaba reiniciándose. La respuesta conserva el mismo contrato,
  // pero cada request usa una sola consulta pesada a la vez.
  const traffic = await getTrafficDistributions(range, {
    includeWeb,
    includeWhatsapp,
    dimension,
    hiddenFilters: resolvedHiddenFilters,
    signal
  });
  if (!includeBreakdowns) {
    const whatsappNumbers = includePhoneBreakdown
      ? await getWhatsAppApiNumberBreakdown(range, {
          hiddenFilters: resolvedHiddenFilters,
          signal
        })
      : [];
    return { traffic, leads: [], appointments: [], conversions: [], whatsappNumbers };
  }
  const leads = await getSourceBreakdownByMetric('leads', range, {
    hiddenFilters: resolvedHiddenFilters,
    signal
  });
  const appointments = await getSourceBreakdownByMetric('appointments', range, {
    hiddenFilters: resolvedHiddenFilters,
    attributionCalendarIds: resolvedAttributionCalendarIds,
    signal
  });
  const conversions = await getSourceBreakdownByMetric('conversions', range, {
    hiddenFilters: resolvedHiddenFilters,
    signal
  });
  const whatsappNumbers = includePhoneBreakdown
    ? await getWhatsAppApiNumberBreakdown(range, { hiddenFilters: resolvedHiddenFilters, signal })
    : [];

  return { traffic, leads, appointments, conversions, whatsappNumbers };
}

export const getOriginDistribution = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res, {
    timeoutMs: DASHBOARD_ANALYTICS_DEADLINE_MS
  });
  try {
    const {
      startDate,
      endDate,
      includeWeb = '1',
      includeWhatsapp = '1',
      dimension = '',
      includeBreakdowns = '1',
      includePhoneBreakdown
    } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }
    if (dimension && !ORIGIN_TRAFFIC_DIMENSIONS.has(String(dimension))) {
      return res.status(400).json({ success: false, error: 'Dimensión de origen no soportada' })
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal })
    const shouldIncludeWeb = String(includeWeb) !== '0'
    const shouldIncludeWhatsapp = String(includeWhatsapp) !== '0'
    // Clientes anteriores omitían este flag: conservar exactamente el contrato
    // histórico sólo cuando también pidieron breakdowns y WhatsApp. Un `1`
    // explícito es independiente de includeWhatsapp para permitir la carga lazy.
    const shouldIncludePhoneBreakdown = includePhoneBreakdown === undefined
      ? String(includeBreakdowns) !== '0' && shouldIncludeWhatsapp
      : String(includePhoneBreakdown) === '1'
    const data = await computeOriginDistribution(range, {
      includeWeb: shouldIncludeWeb,
      includeWhatsapp: shouldIncludeWhatsapp,
      dimension: dimension ? String(dimension) : null,
      includeBreakdowns: String(includeBreakdowns) !== '0',
      includePhoneBreakdown: shouldIncludePhoneBreakdown,
      signal: requestScope.signal
    })

    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return;
      return res.status(503).json({
        success: false,
        error: 'La distribución de origen tardó demasiado. Intenta nuevamente.',
        code: 'dashboard_origin_deadline',
        retryable: true
      });
    }
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return;
    if (data?.performance?.readPath) {
      if (typeof res.set === 'function') res.set('X-Ristak-Read-Path', data.performance.readPath);
      else res.setHeader?.('X-Ristak-Read-Path', data.performance.readPath);
    }
    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return;
      return res.status(503).json({
        success: false,
        error: 'La distribución de origen tardó demasiado. Intenta nuevamente.',
        code: 'dashboard_origin_deadline',
        retryable: true
      });
    }
    if (
      error?.code === 'message_analytics_projection_warming' ||
      error?.code === 'tracking_analytics_projection_warming'
    ) {
      if (res.writableEnded || res.finished) return;
      if (typeof res.set === 'function') res.set('Retry-After', '2');
      else res.setHeader?.('Retry-After', '2');
      return res.status(503).json({
        success: false,
        error: 'La distribución de origen se está preparando. Reintenta en unos segundos.',
        code: error.code,
        retryable: true,
        projectionStatus: error.projectionStatus || 'warming'
      });
    }
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getOriginDistribution: ${error.message}`)
    logger.error(error.stack)
    res.status(500).json({ success: false, error: 'Error al obtener la distribución de origen' })
  } finally {
    requestScope.cleanup();
  }
}

/**
 * Obtiene TODOS los ingresos y gastos (no solo atribuidos)
 * Para el gráfico principal del Dashboard
 */
async function computeFinancialOverview(range, {
  scope = 'all',
  hiddenFilters,
  signal
} = {}) {
  const timezone = range.appliedTimezone;
  const isAttributed = scope === 'campaigns' || scope === 'attributed';
  const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution';
  const resolvedHiddenFilters = hiddenFilters || await getHiddenContactFilters({ signal });
  const hiddenCondition = buildHiddenContactsCondition(resolvedHiddenFilters, 'c', false);
  const paymentDayExpression = getGroupExpression('date', 'day', timezone);
  const spendDayExpression = getGroupExpression('meta_ads.date', 'day', timezone);

  let revenueQuery = '';
  let revenueParams = [];
  const successfulPayments = successfulPaymentStatusCondition('p');

  if (!useContactAttribution) {
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

  const spendQuery = `
    SELECT
      ${spendDayExpression} as day,
      SUM(spend) as spend
    FROM meta_ads
    WHERE date >= ? AND date <= ?
    GROUP BY day
    ORDER BY day ASC
  `;
  const spendParams = [range.startZoned.toISODate(), range.endZoned.toISODate()];
  const [revenueData, spendData] = await Promise.all([
    db.all(revenueQuery, revenueParams, { signal }),
    db.all(spendQuery, spendParams, { signal })
  ]);

  const revenueMap = new Map(revenueData.map(row => [row.day, parseFloat(row.revenue || 0)]));
  const spendMap = new Map(spendData.map(row => [row.day, parseFloat(row.spend || 0)]));
  const sortedDates = Array.from(new Set([...revenueMap.keys(), ...spendMap.keys()])).sort();

  return sortedDates.map(date => ({
    label: date,
    value: revenueMap.get(date) || 0,
    value2: spendMap.get(date) || 0
  }));
}

export const getFinancialOverview = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res);
  try {
    const { startDate, endDate, scope = 'all' } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const data = await computeFinancialOverview(range, {
      scope,
      signal: requestScope.signal
    });

    if (requestScope.signal.aborted || res.writableEnded || res.finished) return;
    res.json({ success: true, data });

  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getFinancialOverview: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener panorama financiero'
    });
  } finally {
    requestScope.cleanup();
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
 *    - all: DB local filtrada en SQL por date_added (cuando se agendó)
 *    - attribution/campaigns: contactos del rango con cita local activa
 *
 * 4. CLIENTES NUEVOS:
 *    - all: Contactos cuyo PRIMER pago está en el rango (MIN(date) FROM payments)
 *    - attribution/campaigns: COUNT(DISTINCT) WHERE created_at BETWEEN start AND end AND purchases_count > 0
 */
const DEFAULT_DASHBOARD_LABELS = Object.freeze({
  customer: 'Cliente',
  customers: 'Clientes',
  lead: 'Interesado',
  leads: 'Interesados'
});

function parseDashboardLabels(hlConfig) {
  if (!hlConfig?.custom_labels) return DEFAULT_DASHBOARD_LABELS;
  try {
    return { ...DEFAULT_DASHBOARD_LABELS, ...JSON.parse(hlConfig.custom_labels) };
  } catch {
    logger.warn('Error parsing custom_labels, usando valores por defecto');
    return DEFAULT_DASHBOARD_LABELS;
  }
}

async function computeFunnelData(range, {
  scope = 'all',
  includeWeb = true,
  hiddenFilters,
  attributionCalendarIds,
  labels,
  signal
} = {}) {
  const isAttributed = scope === 'campaigns' || scope === 'attributed';
  const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution';
  const [hlConfig, resolvedHiddenFilters, configuredCalendarIds] = await Promise.all([
    labels ? null : db.get('SELECT custom_labels FROM highlevel_config LIMIT 1', [], { signal }),
    hiddenFilters || getHiddenContactFilters({ signal }),
    attributionCalendarIds || getAttributionCalendarIds({ signal })
  ]);
  const resolvedLabels = labels || parseDashboardLabels(hlConfig);
  const calendarIds = Array.isArray(configuredCalendarIds) ? configuredCalendarIds : [];
  const hiddenConditionC = buildHiddenContactsCondition(resolvedHiddenFilters, 'c', false);
  const attributedContactCondition = isAttributed
    ? `c.attribution_ad_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone)}
      )`
    : '';
  const contactRangeConditions = ['c.created_at >= ?', 'c.created_at <= ?'];
  if (attributedContactCondition) contactRangeConditions.push(attributedContactCondition);
  if (hiddenConditionC) contactRangeConditions.push(hiddenConditionC);
  const contactRangeParams = [range.startUtc, range.endUtc];

  let visitorsQuery = 'SELECT 0 AS count';
  let visitorsParams = [];
  if (includeWeb && !useContactAttribution) {
    visitorsQuery = `
      SELECT COUNT(DISTINCT ${getVisitorIdentityExpression()}) as count
      FROM sessions
      WHERE started_at >= ? AND started_at <= ?
    `;
    visitorsParams = [range.startUtc, range.endUtc];
  } else if (includeWeb) {
    visitorsQuery = `
      SELECT COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) as count
      FROM sessions s
      INNER JOIN contacts c ON c.id = s.contact_id
      WHERE c.created_at >= ? AND c.created_at <= ?
        ${attributedContactCondition ? `AND ${attributedContactCondition}` : ''}
    `;
    visitorsParams = [range.startUtc, range.endUtc];
  }

  const leadsQuery = `
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE ${contactRangeConditions.join(' AND ')}
  `;

  const calendarCondition = (alias, params) => {
    if (!calendarIds.length) return '';
    params.push(...calendarIds);
    return `${alias}.calendar_id IN (${calendarIds.map(() => '?').join(', ')})`;
  };

  let appointmentsQuery;
  let appointmentsParams;
  if (useContactAttribution) {
    appointmentsParams = [...contactRangeParams];
    const appointmentConditions = [
      'a.contact_id = c.id',
      `LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${sqlStringList(DASHBOARD_INACTIVE_APPOINTMENT_STATUSES)})`
    ];
    const appointmentCalendarCondition = calendarCondition('a', appointmentsParams);
    if (appointmentCalendarCondition) appointmentConditions.push(appointmentCalendarCondition);
    appointmentsQuery = `
      SELECT COUNT(*) AS count
      FROM contacts c
      WHERE ${contactRangeConditions.join(' AND ')}
        AND EXISTS (
          SELECT 1 FROM appointments a
          WHERE ${appointmentConditions.join(' AND ')}
        )
    `;
  } else {
    appointmentsParams = [range.startUtc, range.endUtc];
    const appointmentConditions = [
      'a.date_added >= ?',
      'a.date_added <= ?',
      'a.contact_id IS NOT NULL'
    ];
    if (hiddenConditionC) appointmentConditions.push(`(c.id IS NULL OR ${hiddenConditionC})`);
    const appointmentCalendarCondition = calendarCondition('a', appointmentsParams);
    if (appointmentCalendarCondition) appointmentConditions.push(appointmentCalendarCondition);
    appointmentsQuery = `
      SELECT COUNT(DISTINCT a.contact_id) AS count
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE ${appointmentConditions.join(' AND ')}
    `;
  }

  const attendanceParams = [...contactRangeParams];
  const attendedAppointmentConditions = [
    'attended_a.contact_id = c.id',
    `LOWER(COALESCE(attended_a.appointment_status, attended_a.status, '')) IN (${sqlStringList(DASHBOARD_ATTENDED_APPOINTMENT_STATUSES)})`
  ];
  const attendanceCalendarCondition = calendarCondition('attended_a', attendanceParams);
  if (attendanceCalendarCondition) attendedAppointmentConditions.push(attendanceCalendarCondition);
  const attendancesQuery = `
    SELECT COUNT(*) AS count
    FROM contacts c
    WHERE ${contactRangeConditions.join(' AND ')}
      AND (
        COALESCE(c.purchases_count, 0) > 0
        OR COALESCE(c.total_paid, 0) > 0
        OR EXISTS (
          SELECT 1 FROM appointment_attendance_signals aas
          WHERE aas.contact_id = c.id
        )
        OR EXISTS (
          SELECT 1 FROM appointments attended_a
          WHERE ${attendedAppointmentConditions.join(' AND ')}
        )
      )
  `;

  let customersQuery;
  let customersParams;
  if (useContactAttribution) {
    customersQuery = `
      SELECT COUNT(DISTINCT c.id) as count
      FROM contacts c
      WHERE COALESCE(c.purchases_count, 0) > 0
        AND ${contactRangeConditions.join(' AND ')}
    `;
    customersParams = [...contactRangeParams];
  } else {
    const statusPlaceholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(',');
    const useProjectedFirstPayment = await isContactListProjectionAvailable();
    const firstPaymentConditions = [
      'first_p.first_payment_date >= ?',
      'first_p.first_payment_date <= ?'
    ];
    if (hiddenConditionC) firstPaymentConditions.push(hiddenConditionC);
    customersQuery = `
      SELECT COUNT(DISTINCT c.id) as count
      FROM contacts c
      INNER JOIN ${useProjectedFirstPayment
        ? 'contact_list_activity first_p'
        : `(SELECT contact_id, MIN(date) as first_payment_date
            FROM payments
            WHERE LOWER(status) IN (${statusPlaceholders})
              AND ${nonTestPaymentCondition()}
            GROUP BY contact_id) first_p`
      } ON first_p.contact_id = c.id
      WHERE ${firstPaymentConditions.join(' AND ')}
    `;
    customersParams = [
      ...(useProjectedFirstPayment ? [] : SUCCESS_PAYMENT_STATUSES),
      range.startUtc,
      range.endUtc
    ];
  }

  // En el plan productivo de 0.1 CPU, estas cinco agregaciones no ganan tiempo
  // real ejecutándose juntas: compiten por memoria/conexiones y alargan todas.
  // El funnel conserva el mismo resultado usando un único carril de lectura.
  const visitorsData = await db.get(visitorsQuery, visitorsParams, { signal });
  const leadsData = await db.get(leadsQuery, contactRangeParams, { signal });
  const appointmentsData = await db.get(appointmentsQuery, appointmentsParams, { signal });
  const attendancesData = await db.get(attendancesQuery, attendanceParams, { signal });
  const customersData = await db.get(customersQuery, customersParams, { signal });

  return [
    ...(includeWeb ? [{ stage: 'Visitantes', value: Number(visitorsData?.count || 0) }] : []),
    { stage: resolvedLabels.leads, value: Number(leadsData?.count || 0) },
    { stage: 'Citas', value: Number(appointmentsData?.count || 0) },
    { stage: 'Asistencias', value: Number(attendancesData?.count || 0) },
    { stage: resolvedLabels.customers, value: Number(customersData?.count || 0) }
  ];
}

export const getFunnelData = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res)
  try {
    const { startDate, endDate, scope = 'all', includeWeb = '1' } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' })
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal })
    const shouldIncludeWeb = String(includeWeb) !== '0'
    const data = await computeFunnelData(range, {
      scope,
      includeWeb: shouldIncludeWeb,
      signal: requestScope.signal
    })
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({ success: true, data })
  } catch (error) {
    if (isDashboardRequestAbort(error, requestScope.signal)) return
    logger.error(`Error en getFunnelData: ${error.message}`)
    logger.error(error.stack)
    res.status(500).json({ success: false, error: 'Error al obtener datos del funnel' })
  } finally {
    requestScope.cleanup()
  }
}

function normalizeDashboardScope(value) {
  return ['all', 'attribution', 'campaigns'].includes(String(value || ''))
    ? String(value)
    : 'all';
}

/**
 * Primer paint de Analíticas móvil. Comparte exactamente los mismos cálculos
 * que Dashboard y los endpoints detallados, pero resuelve rango/contexto una
 * sola vez y devuelve una sola respuesta local. Las vistas elegidas después
 * siguen usando sus endpoints focales.
 */
export const getMobileAnalyticsSnapshot = async (req, res) => {
  const requestScope = createDashboardRequestAbortScope(res, {
    timeoutMs: DASHBOARD_ANALYTICS_DEADLINE_MS
  });
  try {
    const {
      startDate,
      endDate,
      includeWeb = '1',
      funnelScope = 'all',
      financialScope = 'all',
      includePhoneBreakdown
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requieren startDate y endDate' });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal });
    const shouldIncludeWeb = String(includeWeb) !== '0';
    // Bundles anteriores no conocen este flag y esperan el payload completo.
    // Los clientes nuevos envían `0` para sacar este read model del primer paint.
    const shouldIncludePhoneBreakdown = includePhoneBreakdown === undefined
      ? true
      : String(includePhoneBreakdown) === '1';
    const resolvedFunnelScope = normalizeDashboardScope(funnelScope);
    const resolvedFinancialScope = normalizeDashboardScope(financialScope);
    const runContextRead = createDashboardReadLimiter(requestScope.signal, 2);
    const [hiddenFilters, configuredCalendarIds, hlConfig, whatsappPhoneNumbers] = await Promise.all([
      runContextRead(() => getHiddenContactFilters({ signal: requestScope.signal })),
      runContextRead(() => getAttributionCalendarIds({ signal: requestScope.signal })),
      runContextRead(() => db.get('SELECT custom_labels FROM highlevel_config LIMIT 1', [], { signal: requestScope.signal })),
      runContextRead(() => getLocalWhatsAppAnalyticsPhoneNumbers({ signal: requestScope.signal }))
    ]);
    const attributionCalendarIds = Array.isArray(configuredCalendarIds) ? configuredCalendarIds : [];
    const labels = parseDashboardLabels(hlConfig);

    // El snapshot móvil antes disparaba cuatro familias de agregados pesados al
    // mismo tiempo. En una sola CPU eso produjo presión de pool sin paralelismo
    // útil; resolverlas por carril protege también las vistas de escritorio.
    const metrics = await computeDashboardMetrics(range, requestScope.signal, { hiddenFilters });
    const origin = await computeOriginDistribution(range, {
      includeWeb: shouldIncludeWeb,
      includeWhatsapp: true,
      dimension: 'sources',
      includePhoneBreakdown: shouldIncludePhoneBreakdown,
      hiddenFilters,
      attributionCalendarIds,
      signal: requestScope.signal
    });
    const funnel = await computeFunnelData(range, {
      scope: resolvedFunnelScope,
      includeWeb: shouldIncludeWeb,
      hiddenFilters,
      attributionCalendarIds,
      labels,
      signal: requestScope.signal
    });
    const financialChart = await computeFinancialOverview(range, {
      scope: resolvedFinancialScope,
      hiddenFilters,
      signal: requestScope.signal
    });

    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return;
      return res.status(503).json({
        success: false,
        error: 'Analíticas móvil tardó demasiado. Intenta nuevamente.',
        code: 'mobile_analytics_deadline',
        retryable: true
      });
    }
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return;
    res.json({
      success: true,
      data: {
        metrics,
        origin,
        funnel,
        financialChart,
        whatsappPhoneNumbers,
        scopes: {
          funnel: resolvedFunnelScope,
          financial: resolvedFinancialScope
        },
        range: {
          start: range.startUtc,
          end: range.endUtc,
          timezone: range.appliedTimezone
        }
      }
    });
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return;
      return res.status(503).json({
        success: false,
        error: 'Analíticas móvil tardó demasiado. Intenta nuevamente.',
        code: 'mobile_analytics_deadline',
        retryable: true
      });
    }
    if (isDashboardRequestAbort(error, requestScope.signal)) return;
    logger.error(`Error en getMobileAnalyticsSnapshot: ${error.message}`);
    logger.error(error.stack);
    res.status(500).json({ success: false, error: 'Error al obtener Analíticas móvil' });
  } finally {
    requestScope.cleanup();
  }
};

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]|null>} Array de calendar IDs o null si no están configurados
 */
async function getAttributionCalendarIds({ signal } = {}) {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids'],
      signal ? { signal } : undefined
    )

    if (!config || !config.config_value) {
      return null // null = usar todos los calendarios
    }

    const calendarIds = JSON.parse(config.config_value)
    return calendarIds.length > 0 ? calendarIds : null
  } catch (error) {
    if (isDashboardRequestAbort(error, signal)) throw error
    logger.warn(`Error al leer calendarios de atribución: ${error.message} - usando TODOS`)
    return null
  }
}
