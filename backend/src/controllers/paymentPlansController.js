import {
  actionInvoiceSchedule,
  createInstallmentFlow,
  createInvoiceSchedule,
  getInvoiceSchedule,
  listInvoiceSchedules,
  updateInvoiceSchedule,
  getLocalInvoiceSchedule
} from './highlevelController.js'
import { recoverPaymentPlanTax } from '../services/paymentPlanTaxRecoveryService.js'
import { changePaymentPlanCollectionMode } from '../services/paymentPlanCollectionService.js'

// Ristak-owned payment plan routes. The implementation still shares the legacy
// HighLevel handlers so old /highlevel endpoints keep working during extraction.
export const listPaymentPlans = listInvoiceSchedules
export const getPaymentPlan = getInvoiceSchedule
export const createPaymentPlan = createInvoiceSchedule
export const updatePaymentPlan = async (req, res) => {
  const payload = req.body?.payload || req.body || {}
  if (!Object.prototype.hasOwnProperty.call(payload, 'collectionMode')) return updateInvoiceSchedule(req, res)
  try {
    await changePaymentPlanCollectionMode(req.params.scheduleId, payload, { actorId: req.user?.id })
    const data = await getLocalInvoiceSchedule(req.params.scheduleId)
    return res.json({ success: true, data, source: `local_${data?.source || 'payment_plan'}` })
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, error: error.message })
  }
}
export const actionPaymentPlan = actionInvoiceSchedule
export const createPaymentInstallmentFlow = createInstallmentFlow

export const recoverPaymentPlanFiscalTax = async (req, res) => {
  try {
    const data = await recoverPaymentPlanTax(req.params.scheduleId, req.body?.sourcePaymentId, {
      dryRun: req.body?.dryRun !== false,
      expectedPreviewRevision: req.body?.expectedPreviewRevision,
      actorId: req.user?.id
    })
    res.json({ success: true, data })
  } catch (error) {
    res.status(error.status || 400).json({ success: false, code: error.code, error: error.message })
  }
}
