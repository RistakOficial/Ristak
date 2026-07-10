import { resumeWhatsAppQrSessions } from '../services/whatsappQrService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { canRunBackgroundJob } from '../services/licenseService.js'

// Cada cuanto revisa el watchdog que las sesiones de WhatsApp Web con
// credenciales guardadas tengan un socket vivo.
const WATCHDOG_INTERVAL_MS = 4 * 60 * 1000
// Pequeña espera al arrancar para que la base y el resto del boot terminen.
const BOOT_DELAY_MS = 8000

let started = false
let bootTimeoutId = null
let watchdogIntervalId = null

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
  if (started) return
  if (process.env.WHATSAPP_QR_AUTO_RESUME === '0') {
    logger.info('[WhatsApp QR] Auto-reconexion desactivada por WHATSAPP_QR_AUTO_RESUME=0')
    return false
  }
  started = true

  bootTimeoutId = setTimeout(async () => {
    if (isDeployShutdownStarted()) return
    try {
      if (!(await canRunBackgroundJob('whatsapp'))) return
    } catch (error) {
      logger.warn(`[WhatsApp QR] No se pudo validar el plan antes del boot watchdog: ${error.message}`)
      return
    }
    trackDeployDrainWork(
      'cron:whatsapp-qr-watchdog',
      () => withCronLock('whatsapp-qr-watchdog', WATCHDOG_INTERVAL_MS, () => resumeWhatsAppQrSessions({ source: 'boot' })),
      'boot'
    )
      .then(({ result }) => {
        if (result?.resumed) logger.info(`[WhatsApp QR] ${result.resumed} sesion(es) de WhatsApp Web reabiertas al arrancar`)
      })
      .catch(error => {
        logger.warn(`[WhatsApp QR] Fallo la reanudacion inicial de sesiones: ${error.message}`)
      })
  }, BOOT_DELAY_MS)

  watchdogIntervalId = setInterval(async () => {
    if (isDeployShutdownStarted()) return
    try {
      if (!(await canRunBackgroundJob('whatsapp'))) return
    } catch (error) {
      logger.warn(`[WhatsApp QR] No se pudo validar el plan antes del watchdog: ${error.message}`)
      return
    }
    // (WA-003) Lock distribuido: con varias instancias solo una corre el watchdog por tick,
    // evitando que reabran/reemplacen los mismos sockets Baileys en bucle. TTL = el intervalo
    // del propio watchdog. Defensivo: con 1 instancia es inofensivo (fail-open en cronLock).
    trackDeployDrainWork(
      'cron:whatsapp-qr-watchdog',
      () => withCronLock('whatsapp-qr-watchdog', WATCHDOG_INTERVAL_MS, () => resumeWhatsAppQrSessions({ source: 'watchdog' })),
      'watchdog'
    ).catch(error => {
      logger.warn(`[WhatsApp QR] Watchdog de sesiones fallo: ${error.message}`)
    })
  }, WATCHDOG_INTERVAL_MS)

  return true
}

export function stopWhatsAppQrWatchdogCron() {
  if (bootTimeoutId) clearTimeout(bootTimeoutId)
  if (watchdogIntervalId) clearInterval(watchdogIntervalId)
  bootTimeoutId = null
  watchdogIntervalId = null
  started = false
}
