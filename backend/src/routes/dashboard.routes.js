import express from 'express'
import { getMetrics, getChartData, getRoasData, getNewCustomersData, getVisitorsData, getLeadsData, getAppointmentsData, getAttendancesData, getSalesData, getStorageStatus, getTrafficSources, getOriginDistribution, getFunnelData, getFinancialOverview } from '../controllers/dashboardController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()
const requireWebAnalyticsFeature = requireFeature('web_analytics')

function requireWebAnalyticsWhenIncluded(req, res, next) {
  if (String(req.query.includeWeb || '1') === '0') return next()
  return requireWebAnalyticsFeature(req, res, next)
}

router.use(requireAuth)
router.use(requireModuleAccess('dashboard'))

router.get('/metrics', getMetrics)
router.get('/chart-data', getChartData)
router.get('/financial-overview', getFinancialOverview) // Ingresos y gastos TOTALES
router.get('/roas', getRoasData)
router.get('/new-customers', getNewCustomersData)
router.get('/visitors', requireWebAnalyticsFeature, getVisitorsData) // Visitantes únicos desde sessions
router.get('/leads', getLeadsData)
router.get('/appointments', getAppointmentsData)
router.get('/attendances', getAttendancesData)
router.get('/sales', getSalesData)
router.get('/storage-status', getStorageStatus)
router.get('/traffic-sources', requireWebAnalyticsWhenIncluded, getTrafficSources)
router.get('/origin-distribution', requireWebAnalyticsWhenIncluded, getOriginDistribution)
router.get('/funnel', requireWebAnalyticsWhenIncluded, getFunnelData)

export default router
