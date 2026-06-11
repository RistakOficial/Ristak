import { resumeWhatsAppQrSessions } from '../services/whatsappQrService.js'
import { logger } from '../utils/logger.js'

// Cada cuanto revisa el watchdog que las sesiones de WhatsApp Web con
// credenciales guardadas tengan un socket vivo.
const WATCHDOG_INTERVAL_MS = 4 * 60 * 1000
// Pequeña espera al arrancar para que la base y el resto del boot terminen.
const BOOT_DELAY_MS = 8000

/**
 * Mantiene vivas las sesiones de WhatsApp Web (Baileys):
 * - Al arrancar el servidor reabre las sesiones que quedaron conectadas antes
 *   del reinicio/deploy (sin esto, cada deploy dejaba los sockets muertos).
 * - Cada pocos minutos revive sesiones que agotaron sus reintentos de
 *   reconexion por una caida larga de red o de WhatsApp.
 * Se desactiva con WHATSAPP_QR_AUTO_RESUME=0 (util para entornos de prueba
 * que comparten base de datos con produccion).
 */
export function startWhatsAppQrWatchdogCron() {
  if (process.env.WHATSAPP_QR_AUTO_RESUME === '0') {
    logger.info('[WhatsApp QR] Auto-reconexion desactivada por WHATSAPP_QR_AUTO_RESUME=0')
    return
  }

  setTimeout(() => {
    resumeWhatsAppQrSessions({ source: 'boot' })
      .then(({ resumed }) => {
        if (resumed) logger.info(`[WhatsApp QR] ${resumed} sesion(es) de WhatsApp Web reabiertas al arrancar`)
      })
      .catch(error => {
        logger.warn(`[WhatsApp QR] Fallo la reanudacion inicial de sesiones: ${error.message}`)
      })
  }, BOOT_DELAY_MS)

  setInterval(() => {
    resumeWhatsAppQrSessions({ source: 'watchdog' }).catch(error => {
      logger.warn(`[WhatsApp QR] Watchdog de sesiones fallo: ${error.message}`)
    })
  }, WATCHDOG_INTERVAL_MS)
}
