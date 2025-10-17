/**
 * Utilidad para construir URLs de pago correctas usando domain
 *
 * Formato: https://{domain}/invoice/{invoiceId}
 * Ejemplo: https://link.raulgomez.com.mx/invoice/68ec481e739453552bc9e15f
 */

/**
 * Construye la URL correcta para un invoice de pago
 * @param {string|null} domain - Dominio de la empresa (ej: link.raulgomez.com.mx)
 * @param {string} invoiceId - ID del invoice de GHL
 * @returns {string} URL completa del invoice
 */
export function buildInvoicePaymentUrl(domain, invoiceId) {
  if (!domain) {
    // Fallback si no hay domain configurado
    console.warn('⚠️  No hay domain configurado, usando URL de fallback');
    return `https://payments.msgsndr.com/invoice/${invoiceId}`;
  }

  // Asegurar que el dominio no tenga https:// al principio
  const cleanDomain = domain.replace(/^https?:\/\//, '');

  return `https://${cleanDomain}/invoice/${invoiceId}`;
}

/**
 * Construye la URL correcta para un schedule de pago recurrente
 * @param {string|null} domain - Dominio de la empresa (ej: link.raulgomez.com.mx)
 * @param {string} scheduleId - ID del schedule de GHL
 * @returns {string} URL completa del schedule
 */
export function buildSchedulePaymentUrl(domain, scheduleId) {
  if (!domain) {
    // Fallback si no hay domain configurado
    console.warn('⚠️  No hay domain configurado, usando URL de fallback');
    return `https://payments.msgsndr.com/invoice/schedule/${scheduleId}`;
  }

  // Asegurar que el dominio no tenga https:// al principio
  const cleanDomain = domain.replace(/^https?:\/\//, '');

  return `https://${cleanDomain}/invoice/${scheduleId}`;
}
