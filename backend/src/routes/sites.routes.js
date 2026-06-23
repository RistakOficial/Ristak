import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  createBlockHandler,
  createSiteFolderHandler,
  importSiteHtmlHandler,
  createSiteHandler,
  createSiteWithAIHtmlHandler,
  createPreviewSessionHandler,
  deleteBlockHandler,
  deleteSiteHandler,
  getSitesDomainHandler,
  getImportedSiteMappingHandler,
  getSiteHandler,
  getSiteFoldersHandler,
  getSitesAnalyticsSummaryHandler,
  getSitesHandler,
  getSitesVideoAnalyticsHandler,
  getSitesVideoAssetsHandler,
  getSitesVideoViewersHandler,
  importedSiteAssetHandler,
  metaPageEventPublicHandler,
  previewCalendarHandler,
  previewSiteHandler,
  removeSitesAppDomainHandler,
  removeSitesDomainHandler,
  previewSiteSessionHandler,
  reorderBlocksHandler,
  restoreBlocksHandler,
  setSitesDefaultRouteHandler,
  sitesFontCssHandler,
  sitesFontFileHandler,
  submitPublicSiteHandler,
  updateBlockHandler,
  updateSiteFolderHandler,
  updateImportedSiteCodeFilesHandler,
  updateImportedSiteEditableContentHandler,
  updateImportedSiteHtmlWithAIHandler,
  updateImportedSiteMappingHandler,
  updateSiteHandler,
  verifySitesAppDomainHandler,
  verifySitesDomainHandler,
  verifySiteDomainHandler
} from '../controllers/sitesController.js'

const router = express.Router()

router.post('/public/submit', submitPublicSiteHandler)
router.post('/public/meta-event', metaPageEventPublicHandler)
router.get('/public/fonts.css', sitesFontCssHandler)
router.get('/public/font-file', sitesFontFileHandler)
router.get('/public/calendar-preview/:slug', requireFeature('google_calendar'), previewCalendarHandler)
router.get('/public/imported-assets/:siteId/*', importedSiteAssetHandler)
router.get('/:siteId/preview-session/:token', previewSiteSessionHandler)

router.use(requireAuth)
router.use(requireModuleAccess('sites'))

router.get('/', getSitesHandler)
router.post('/', createSiteHandler)
router.post('/ai-create-html', createSiteWithAIHtmlHandler)
router.post('/import-html', importSiteHtmlHandler)
router.get('/domain', getSitesDomainHandler)
router.post('/domain/verify', verifySitesDomainHandler)
router.post('/domain/default-route', setSitesDefaultRouteHandler)
router.delete('/domain', removeSitesDomainHandler)
router.post('/domain/app/verify', verifySitesAppDomainHandler)
router.delete('/domain/app', removeSitesAppDomainHandler)
router.post('/analytics/summary', getSitesAnalyticsSummaryHandler)
router.get('/video-assets', getSitesVideoAssetsHandler)
router.get('/video-analytics/:assetId', getSitesVideoAnalyticsHandler)
router.get('/video-analytics/:assetId/viewers', getSitesVideoViewersHandler)
router.get('/folders', getSiteFoldersHandler)
router.post('/folders', createSiteFolderHandler)
router.put('/folders/:folderId', updateSiteFolderHandler)
router.get('/:siteId/import-mapping', getImportedSiteMappingHandler)
router.get('/:siteId', getSiteHandler)
router.put('/:siteId', updateSiteHandler)
router.delete('/:siteId', deleteSiteHandler)
router.get('/:siteId/preview', previewSiteHandler)
router.post('/:siteId/preview-session', createPreviewSessionHandler)
router.post('/:siteId/ai-edit-html', updateImportedSiteHtmlWithAIHandler)
router.patch('/:siteId/import-content', updateImportedSiteEditableContentHandler)
router.patch('/:siteId/import-code', updateImportedSiteCodeFilesHandler)
router.put('/:siteId/import-mapping', updateImportedSiteMappingHandler)
router.post('/:siteId/verify-domain', verifySiteDomainHandler)
router.post('/:siteId/blocks', createBlockHandler)
router.post('/:siteId/blocks/restore', restoreBlocksHandler)
router.put('/:siteId/blocks/reorder', reorderBlocksHandler)
router.put('/:siteId/blocks/:blockId', updateBlockHandler)
router.delete('/:siteId/blocks/:blockId', deleteBlockHandler)

export default router
