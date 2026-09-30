import {
  actionInvoiceSchedule,
  createInstallmentFlow,
  createInvoiceSchedule,
  getInvoiceSchedule,
  listInvoiceSchedules,
  updateInvoiceSchedule
} from './highlevelController.js'
import { recoverPaymentPlanTax } from '../services/paymentPlanTaxRecoveryService.js'

// Ristak-owned payment plan routes. The implementation still shares the legacy
// HighLevel handlers so old /highlevel endpoints keep working during extraction.
export const listPaymentPlans = listInvoiceSchedules
export const getPaymentPlan = getInvoiceSchedule
export const createPaymentPlan = createInvoiceSchedule
export const updatePaymentPlan = updateInvoiceSchedule
export const actionPaymentPlan = actionInvoiceSchedule
export const createPaymentInstallmentFlow = createInstallmentFlow

export const recoverPaymentPlanFiscalTax = async (req, res) => {
  try {
    const data = await recoverPaymentPlanTax(req.params.scheduleId, req.body?.sourcePaymentId, {
      dryRun: req.body?.dryRun !== false,
      expectedPreviewHash: req.body?.expectedPreviewHash,
      actorId: req.user?.id
    })
    res.json({ success: true, data })
  } catch (error) {
    res.status(error.status || 400).json({ success: false, code: error.code, error: error.message })
  }
}
