import express from 'express'
import {
  getFunnelData,
  getMetrics as getDashboardMetrics,
  getTrafficSources
} from '../controllers/dashboardController.js'
import {
  getCampaignsReport,
  getContactsList,
  getContactsReport,
  getMetrics as getReportMetrics,
  getPaymentsReport,
  getSummary as getReportsSummary,
  getTransactionsList
} from '../controllers/reportsController.js'
import {
  getContactById,
  getContactJourney,
  getContacts,
  searchContacts
} from '../controllers/contactsController.js'
import {
  getTransactionById,
  getTransactionStats,
  getTransactionSummary,
  getTransactions
} from '../controllers/transactionsController.js'
import { requireApiToken } from '../middleware/apiTokenMiddleware.js'
import { getExternalApiAppId } from '../utils/apiTokens.js'

const router = express.Router()

function getRequestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${proto}://${host}` : ''
}

async function getOpenApiSpec(req, res) {
  try {
    const origin = getRequestOrigin(req)
    const appId = await getExternalApiAppId()

    res.json({
    openapi: '3.1.0',
    info: {
      title: 'Ristak External API',
      version: '1.0.0',
      description: 'API autenticada para consultar datos de Ristak desde sistemas externos autorizados.'
    },
    'x-ristak-app-id': appId,
    servers: origin ? [{ url: origin }] : undefined,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Ristak API token'
        }
      },
      schemas: {
        ApiEnvelope: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: ['object', 'array', 'null'] },
            error: { type: 'string' }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/external/me': {
        get: {
          operationId: 'getAuthenticatedRistakUser',
          summary: 'Obtiene el usuario ligado al API token',
          responses: {
            200: { description: 'Usuario autenticado' },
            401: { description: 'API token inválido' }
          }
        }
      },
      '/api/external/dashboard/metrics': {
        get: {
          operationId: 'getRistakDashboardMetrics',
          summary: 'Consulta métricas generales del dashboard',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Métricas del dashboard' } }
        }
      },
      '/api/external/dashboard/funnel': {
        get: {
          operationId: 'getRistakDashboardFunnel',
          summary: 'Consulta el embudo de conversión',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Datos del embudo' } }
        }
      },
      '/api/external/dashboard/traffic-sources': {
        get: {
          operationId: 'getRistakTrafficSources',
          summary: 'Consulta fuentes de tráfico',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Fuentes de tráfico' } }
        }
      },
      '/api/external/reports/summary': {
        get: {
          operationId: 'getRistakReportsSummary',
          summary: 'Consulta resumen consolidado de contactos, pagos y campañas',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'scope', in: 'query', schema: { type: 'string', enum: ['all', 'paid', 'organic'] } }
          ],
          responses: { 200: { description: 'Resumen consolidado' } }
        }
      },
      '/api/external/reports/metrics': {
        get: {
          operationId: 'getRistakReportMetrics',
          summary: 'Consulta métricas por periodo',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } }
          ],
          responses: { 200: { description: 'Métricas por periodo' } }
        }
      },
      '/api/external/reports/contacts': {
        get: {
          operationId: 'getRistakContactsReport',
          summary: 'Consulta reporte de contactos',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } }
          ],
          responses: { 200: { description: 'Reporte de contactos' } }
        }
      },
      '/api/external/reports/payments': {
        get: {
          operationId: 'getRistakPaymentsReport',
          summary: 'Consulta reporte de pagos',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Reporte de pagos' } }
        }
      },
      '/api/external/reports/campaigns': {
        get: {
          operationId: 'getRistakCampaignsReport',
          summary: 'Consulta reporte de campañas',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Reporte de campañas' } }
        }
      },
      '/api/external/reports/contacts/list': {
        get: {
          operationId: 'getRistakContactsListReport',
          summary: 'Consulta lista filtrada de contactos para reportes',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'type', in: 'query', schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Lista de contactos' } }
        }
      },
      '/api/external/reports/transactions': {
        get: {
          operationId: 'getRistakTransactionsListReport',
          summary: 'Consulta lista de transacciones exitosas para reportes',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Lista de transacciones' } }
        }
      },
      '/api/external/contacts': {
        get: {
          operationId: 'listRistakContacts',
          summary: 'Lista contactos con paginación y filtros',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Contactos' } }
        }
      },
      '/api/external/contacts/search': {
        get: {
          operationId: 'searchRistakContacts',
          summary: 'Busca contactos por nombre, email o teléfono',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Resultados de búsqueda' } }
        }
      },
      '/api/external/contacts/{id}': {
        get: {
          operationId: 'getRistakContactById',
          summary: 'Obtiene detalle de un contacto',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Contacto' }, 404: { description: 'Contacto no encontrado' } }
        }
      },
      '/api/external/contacts/{id}/journey': {
        get: {
          operationId: 'getRistakContactJourney',
          summary: 'Obtiene el journey de un contacto',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Journey del contacto' } }
        }
      },
      '/api/external/transactions': {
        get: {
          operationId: 'listRistakTransactions',
          summary: 'Lista transacciones con paginación y filtros',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5000 } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Transacciones' } }
        }
      },
      '/api/external/transactions/stats': {
        get: {
          operationId: 'getRistakTransactionStats',
          summary: 'Consulta estadísticas de transacciones',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Estadísticas de transacciones' } }
        }
      },
      '/api/external/transactions/summary': {
        get: {
          operationId: 'getRistakTransactionSummary',
          summary: 'Consulta resumen financiero de transacciones',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Resumen de transacciones' } }
        }
      },
      '/api/external/transactions/{id}': {
        get: {
          operationId: 'getRistakTransactionById',
          summary: 'Obtiene detalle de una transacción',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Transacción' }, 404: { description: 'Transacción no encontrada' } }
        }
      }
    }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'No se pudo generar el schema OpenAPI'
    })
  }
}

router.get('/openapi.json', getOpenApiSpec)

router.use(requireApiToken)

router.get('/me', async (req, res) => {
  try {
    res.json({
      success: true,
      appId: await getExternalApiAppId(),
      user: req.apiUser
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'No se pudo obtener el usuario autenticado'
    })
  }
})

router.get('/dashboard/metrics', getDashboardMetrics)
router.get('/dashboard/funnel', getFunnelData)
router.get('/dashboard/traffic-sources', getTrafficSources)

router.get('/reports/summary', getReportsSummary)
router.get('/reports/metrics', getReportMetrics)
router.get('/reports/contacts', getContactsReport)
router.get('/reports/payments', getPaymentsReport)
router.get('/reports/campaigns', getCampaignsReport)
router.get('/reports/contacts/list', getContactsList)
router.get('/reports/transactions', getTransactionsList)

router.get('/contacts/search', searchContacts)
router.get('/contacts/:id/journey', getContactJourney)
router.get('/contacts/:id', getContactById)
router.get('/contacts', getContacts)

router.get('/transactions/stats', getTransactionStats)
router.get('/transactions/summary', getTransactionSummary)
router.get('/transactions/:id', getTransactionById)
router.get('/transactions', getTransactions)

export default router
