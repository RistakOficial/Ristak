import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import {
  createBlockHandler,
  importSiteHtmlHandler,
  createSiteHandler,
  createSiteWithAIHtmlHandler,
  deleteBlockHandler,
  deleteSiteHandler,
  getSitesDomainHandler,
  getImportedSiteMappingHandler,
  getSiteHandler,
  getSitesHandler,
  importedSiteAssetHandler,
  metaPageEventPublicHandler,
  previewCalendarHandler,
  previewSiteHandler,
  reorderBlocksHandler,
  restoreBlocksHandler,
  submitPublicSiteHandler,
  updateBlockHandler,
  updateImportedSiteHtmlWithAIHandler,
  updateImportedSiteMappingHandler,
  updateSiteHandler,
  verifySitesDomainHandler,
  verifySiteDomainHandler
} from '../controllers/sitesController.js'

const router = express.Router()

router.post('/public/submit', submitPublicSiteHandler)
router.post('/public/meta-event', metaPageEventPublicHandler)
router.get('/public/calendar-preview/:slug', previewCalendarHandler)
router.get('/public/imported-assets/:siteId/*', importedSiteAssetHandler)

router.use(requireAuth)

router.get('/', getSitesHandler)
router.post('/', createSiteHandler)
router.post('/ai-create-html', createSiteWithAIHtmlHandler)
router.post('/import-html', importSiteHtmlHandler)
router.get('/domain', getSitesDomainHandler)
router.post('/domain/verify', verifySitesDomainHandler)
router.get('/:siteId/preview', previewSiteHandler)
router.get('/:siteId/import-mapping', getImportedSiteMappingHandler)
router.get('/:siteId', getSiteHandler)
router.put('/:siteId', updateSiteHandler)
router.delete('/:siteId', deleteSiteHandler)
router.post('/:siteId/ai-edit-html', updateImportedSiteHtmlWithAIHandler)
router.put('/:siteId/import-mapping', updateImportedSiteMappingHandler)
router.post('/:siteId/verify-domain', verifySiteDomainHandler)
router.post('/:siteId/blocks', createBlockHandler)
router.post('/:siteId/blocks/restore', restoreBlocksHandler)
router.put('/:siteId/blocks/reorder', reorderBlocksHandler)
router.put('/:siteId/blocks/:blockId', updateBlockHandler)
router.delete('/:siteId/blocks/:blockId', deleteBlockHandler)

export default router
