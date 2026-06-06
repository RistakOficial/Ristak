import express from 'express'
import { getMetrics, getChartData, getRoasData, getNewCustomersData, getVisitorsData, getLeadsData, getAppointmentsData, getAttendancesData, getSalesData, getStorageStatus, getTrafficSources, getOriginDistribution, getFunnelData, getFinancialOverview } from '../controllers/dashboardController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/metrics', getMetrics)
router.get('/chart-data', getChartData)
router.get('/financial-overview', getFinancialOverview) // Ingresos y gastos TOTALES
router.get('/roas', getRoasData)
router.get('/new-customers', getNewCustomersData)
router.get('/visitors', getVisitorsData) // Visitantes únicos desde sessions
router.get('/leads', getLeadsData)
router.get('/appointments', getAppointmentsData)
router.get('/attendances', getAttendancesData)
router.get('/sales', getSalesData)
router.get('/storage-status', getStorageStatus)
router.get('/traffic-sources', getTrafficSources)
router.get('/origin-distribution', getOriginDistribution)
router.get('/funnel', getFunnelData)

export default router
