const AMBIGUOUS_PAYMENT_ERROR_STATUSES = new Set([402, 408, 409, 425, 429]);

export function getPaymentErrorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const status = Number((error as { status?: unknown }).status || 0);
  return Number.isInteger(status) ? status : 0;
}

/**
 * Solo una validacion definitivamente rechazada puede iniciar otro intento.
 * Timeouts, conflictos, rate limits y fallas 5xx pueden esconder una mutacion
 * aceptada por la pasarela, asi que deben conservar exactamente la misma llave.
 */
export function shouldRotatePaymentAttemptAfterError(error: unknown): boolean {
  const status = getPaymentErrorStatus(error);
  return status >= 400
    && status < 500
    && !AMBIGUOUS_PAYMENT_ERROR_STATUSES.has(status);
}
