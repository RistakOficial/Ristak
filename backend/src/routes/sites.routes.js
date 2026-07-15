import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  createBlockHandler,
  createSiteFolderHandler,
  createSitesPublicDomainHandler,
  importSiteHtmlHandler,
  createSiteHandler,
  createSiteWithAIHtmlHandler,
  createPreviewSessionHandler,
  deleteBlockHandler,
  deleteSiteContentAssetHandler,
  deleteSiteHandler,
  getSitesDomainHandler,
  getImportedSiteMappingHandler,
  getSiteHandler,
  getSiteFoldersHandler,
  getSiteSelectorsHandler,
  getSitesAnalyticsSummaryHandler,
  getSitesHandler,
  getSiteContentAssetsHandler,
  getSitesVideoAnalyticsHandler,
  getSitesVideoAssetsHandler,
  getSitesVideoViewersHandler,
  importedSiteAssetHandler,
  publicSiteContentAssetHandler,
  metaPageEventPublicHandler,
  previewCalendarHandler,
  previewSiteHandler,
  removeSitesAppDomainHandler,
  removeSitesPublicDomainByIdHandler,
  removeSitesDomainHandler,
  previewSiteSessionHandler,
  publicSiteContactPrefillHandler,
  publicSitePaymentStatusHandler,
  sitePaymentCheckoutInitHandler,
  sitePaymentCheckoutPayHandler,
  sitePaymentCheckoutPrepareHandler,
  reorderBlocksHandler,
  restoreBlocksHandler,
  setSitesPublicDomainDefaultRouteHandler,
  setSitesDefaultRouteHandler,
  sitesFontCssHandler,
  sitesFontFileHandler,
  submitPublicSiteHandler,
  updateBlockHandler,
  updateSiteFolderHandler,
  updateImportedSiteCodeFilesHandler,
  updateImportedSiteEditableContentHandler,
  updateImportedSiteHtmlWithAIHandler,
  updateImportedSiteFieldMappingHandler,
  updateSiteHandler,
  saveSiteContentAssetHandler,
  verifySitesPublicDomainByIdHandler,
  verifySitesAppDomainHandler,
  verifySitesDomainHandler,
  verifySiteDomainHandler
} from '../controllers/sitesController.js'

const router = express.Router()

function containsSitePaymentFeature(value, depth = 0) {
  if (!value || depth > 8) return false
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return /data-(?:rstk|ristak|ristack)-(?:native-element|element|element-type|component|widget)\s*=\s*(?:"payment"|'payment'|payment(?:\s|>))/.test(normalized) ||
      normalized.includes('data-rstk-payment-gate') ||
      normalized.includes('site-payment-checkout')
  }
  if (Array.isArray(value)) return value.some((item) => containsSitePaymentFeature(item, depth + 1))
  if (typeof value !== 'object') return false

  const type = String(value.type || value.blockType || value.elementType || value.nativeElement || value.kind || '').trim().toLowerCase()
  if (type === 'payment' || type === 'checkout' || type === 'payment-gate' || type === 'payment_gate') return true

  const paymentGate = value.paymentGate || value.payment_gate || value.checkout || value.paymentCheckout
  if (paymentGate && typeof paymentGate === 'object' && (
    paymentGate.enabled === true ||
    paymentGate.required === true ||
    paymentGate.collectPayment === true ||
    paymentGate.collect_payment === true
  )) {
    return true
  }

  return Object.entries(value).some(([key, entryValue]) => {
    const normalizedKey = key.toLowerCase()
    if ((normalizedKey.includes('payment') || normalizedKey.includes('checkout')) && entryValue === true) return true
    return containsSitePaymentFeature(entryValue, depth + 1)
  })
}

function requirePaymentsForSitePaymentFeature(req, res, next) {
  if (!containsSitePaymentFeature(req.body)) return next()
  return requireFeature('payment_checkout')(req, res, next)
}

router.post('/public/submit', submitPublicSiteHandler)
router.get('/public/contact-prefill', publicSiteContactPrefillHandler)
router.get('/public/payments/:publicPaymentId/status', requireFeature('payment_checkout'), publicSitePaymentStatusHandler)
router.post('/public/checkout/init', requireFeature('payment_checkout'), sitePaymentCheckoutInitHandler)
router.post('/public/checkout/pay', requireFeature('payment_checkout'), sitePaymentCheckoutPayHandler)
router.post('/public/checkout/prepare-installments', requireFeature('payment_checkout'), requireFeature('payment_plans'), sitePaymentCheckoutPrepareHandler)
router.post('/public/meta-event', metaPageEventPublicHandler)
router.get('/public/fonts.css', sitesFontCssHandler)
router.get('/public/font-file', sitesFontFileHandler)
router.get('/public/calendar-preview/:slug', requireFeature('appointments'), previewCalendarHandler)
router.get('/public/imported-assets/:siteId/*', importedSiteAssetHandler)
router.get('/public/content-assets/:siteId/:assetKey', publicSiteContentAssetHandler)
router.get('/:siteId/preview-session/:token', previewSiteSessionHandler)

router.use(requireAuth)
router.use(requireModuleAccess('sites'))

router.get('/', getSitesHandler)
router.get('/selectors', getSiteSelectorsHandler)
router.post('/', requirePaymentsForSitePaymentFeature, createSiteHandler)
router.post('/ai-create-html', requirePaymentsForSitePaymentFeature, createSiteWithAIHtmlHandler)
router.post('/import-html', requirePaymentsForSitePaymentFeature, importSiteHtmlHandler)
router.get('/domain', getSitesDomainHandler)
router.post('/domain/verify', verifySitesDomainHandler)
router.post('/domain/default-route', setSitesDefaultRouteHandler)
router.delete('/domain', removeSitesDomainHandler)
router.post('/domains/public', createSitesPublicDomainHandler)
router.post('/domains/public/:domainId/verify', verifySitesPublicDomainByIdHandler)
router.post('/domains/public/:domainId/default-route', setSitesPublicDomainDefaultRouteHandler)
router.delete('/domains/public/:domainId', removeSitesPublicDomainByIdHandler)
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
router.get('/:siteId/content-assets', getSiteContentAssetsHandler)
router.post('/:siteId/content-assets', saveSiteContentAssetHandler)
router.put('/:siteId/content-assets/:bindingId', saveSiteContentAssetHandler)
router.delete('/:siteId/content-assets/:bindingId', deleteSiteContentAssetHandler)
router.get('/:siteId', getSiteHandler)
router.put('/:siteId', requirePaymentsForSitePaymentFeature, updateSiteHandler)
router.delete('/:siteId', deleteSiteHandler)
router.get('/:siteId/preview', previewSiteHandler)
router.post('/:siteId/preview', previewSiteHandler)
router.post('/:siteId/preview-session', createPreviewSessionHandler)
router.post('/:siteId/ai-edit-html', updateImportedSiteHtmlWithAIHandler)
router.patch('/:siteId/import-content', requirePaymentsForSitePaymentFeature, updateImportedSiteEditableContentHandler)
router.patch('/:siteId/import-code', requirePaymentsForSitePaymentFeature, updateImportedSiteCodeFilesHandler)
router.patch('/:siteId/import-mapping', requirePaymentsForSitePaymentFeature, updateImportedSiteFieldMappingHandler)
router.post('/:siteId/verify-domain', verifySiteDomainHandler)
router.post('/:siteId/blocks', requirePaymentsForSitePaymentFeature, createBlockHandler)
router.post('/:siteId/blocks/restore', restoreBlocksHandler)
router.put('/:siteId/blocks/reorder', reorderBlocksHandler)
router.put('/:siteId/blocks/:blockId', requirePaymentsForSitePaymentFeature, updateBlockHandler)
router.delete('/:siteId/blocks/:blockId', deleteBlockHandler)

export default router
