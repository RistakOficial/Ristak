export const SUCCESS_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'captured',
  'approved',
  'accredited'
])

export const NON_LIVE_PAYMENT_MODES = new Set([
  'test',
  'sandbox',
  'demo',
  'preview',
  'simulation',
  'simulated',
  // Una foto recibida sólo prueba que hay algo que revisar, no que los fondos
  // hayan llegado. Incluso un cambio accidental de status no debe desbloquearla.
  'manual_review',
  'manual review'
])
