export const WHATSAPP_QR_FALLBACK_CONFIRM_WORD = 'QR'

export const WHATSAPP_QR_FALLBACK_TITLE = 'Activar respaldo por QR'

export const buildWhatsAppQrFallbackMessage = (contextLabel: string) => (
  `WhatsApp API seguirá siendo el envío principal para ${contextLabel}. ` +
  'El QR sólo se usará como respaldo si la API no está disponible, Meta restringe el envío o el mensaje no puede salir por la ruta oficial. ' +
  'Este respaldo usa WhatsApp Web por QR, puede desconectarse y puede aumentar el riesgo de bloqueo del número. Actívalo sólo si aceptas ese riesgo.'
)
