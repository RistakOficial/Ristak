import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import {
  createBlockHandler,
  createSiteHandler,
  createSiteWithAIHandler,
  deleteBlockHandler,
  deleteSiteHandler,
  getSitesDomainHandler,
  getSiteHandler,
  getSitesHandler,
  metaPageEventPublicHandler,
  previewCalendarHandler,
  previewSiteHandler,
  reorderBlocksHandler,
  submitPublicSiteHandler,
  updateBlockHandler,
  updateSiteHandler,
  verifySitesDomainHandler,
  verifySiteDomainHandler
} from '../controllers/sitesController.js'

const router = express.Router()

router.post('/public/submit', submitPublicSiteHandler)
router.post('/public/meta-event', metaPageEventPublicHandler)
router.get('/public/calendar-preview/:slug', previewCalendarHandler)

router.use(requireAuth)

router.get('/', getSitesHandler)
router.post('/', createSiteHandler)
router.post('/ai-create', createSiteWithAIHandler)
router.get('/domain', getSitesDomainHandler)
router.post('/domain/verify', verifySitesDomainHandler)
router.get('/:siteId/preview', previewSiteHandler)
router.get('/:siteId', getSiteHandler)
router.put('/:siteId', updateSiteHandler)
router.delete('/:siteId', deleteSiteHandler)
router.post('/:siteId/verify-domain', verifySiteDomainHandler)
router.post('/:siteId/blocks', createBlockHandler)
router.put('/:siteId/blocks/reorder', reorderBlocksHandler)
router.put('/:siteId/blocks/:blockId', updateBlockHandler)
router.delete('/:siteId/blocks/:blockId', deleteBlockHandler)

export default router
