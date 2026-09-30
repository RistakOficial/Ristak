import { searchGigstackClients, linkGigstackContact, validateGigstackContact } from '../services/gigstackContactService.js'
import { recoverPaymentFiscalTax } from '../services/paymentFiscalTaxRecoveryService.js'
import { issueGigstackInvoiceForTransaction } from '../services/gigstackInvoiceService.js'

const adminAction = operation => async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ success: false, code: 'admin_required', error: 'Solo un administrador puede reparar vínculos o facturas fiscales.' })
  if (req.method !== 'GET' && !/^[A-Za-z0-9._:-]{8,180}$/.test(String(req.headers?.['idempotency-key'] || ''))) {
    return res.status(400).json({ success: false, code: 'idempotency_key_required', error: 'La operación requiere una clave idempotente.' })
  }
  try {
    res.json({ success: true, data: await operation(req) })
  } catch (error) {
    res.status(error.status || 502).json({ success: false, code: error.code, error: error.message })
  }
}

export const searchFiscalClients = adminAction(req => searchGigstackClients(req.query))
export const linkFiscalContact = adminAction(req => linkGigstackContact({
  ...req.body, contactId: req.params.contactId, dryRun: req.body?.dryRun !== false, actorId: req.user.id
}))
export const validateFiscalContact = adminAction(req => validateGigstackContact({
  ...req.body, contactId: req.params.contactId, dryRun: req.body?.dryRun !== false
}))
export const recoverFiscalPaymentTax = adminAction(req => recoverPaymentFiscalTax(req.params.id, req.body.sourcePaymentId, {
  dryRun: req.body?.dryRun !== false, expectedPreviewRevision: req.body.expectedPreviewRevision, actorId: req.user.id
}))
export const issueFiscalPaymentInvoice = adminAction(req => issueGigstackInvoiceForTransaction(req.params.id, {
  dryRun: req.body?.dryRun !== false, expectedPreviewRevision: req.body.expectedPreviewRevision,
  deliveryChannel: req.body?.deliveryChannel || 'none', actorId: req.user.id
}))
