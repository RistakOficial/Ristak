import {
  actionInvoiceSchedule,
  createInstallmentFlow,
  createInvoiceSchedule,
  getInvoiceSchedule,
  listInvoiceSchedules,
  updateInvoiceSchedule
} from './highlevelController.js'

// Ristak-owned payment plan routes. The implementation still shares the legacy
// HighLevel handlers so old /highlevel endpoints keep working during extraction.
export const listPaymentPlans = listInvoiceSchedules
export const getPaymentPlan = getInvoiceSchedule
export const createPaymentPlan = createInvoiceSchedule
export const updatePaymentPlan = updateInvoiceSchedule
export const actionPaymentPlan = actionInvoiceSchedule
export const createPaymentInstallmentFlow = createInstallmentFlow
