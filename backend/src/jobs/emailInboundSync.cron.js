import { syncInboundEmailOnce } from '../services/emailService.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { logger } from '../utils/logger.js'

const EMAIL_INBOUND_SYNC_INTERVAL_MS = 60_000

let intervalId = null
let immediateRunScheduled = false

async function runEmailInboundSync(reason) {
  if (!(await canRunBackgroundJob('email'))) return
  syncInboundEmailOnce({ reason }).catch(error => {
    logger.warn(`[Correo IMAP] Sync ${reason} fallido: ${error.message}`)
  })
}

export function startEmailInboundSyncCron() {
  if (intervalId) return true

  intervalId = setInterval(() => {
    runEmailInboundSync('interval').catch(error => {
      logger.warn(`[Correo IMAP] Sync interval fallido: ${error.message}`)
    })
  }, EMAIL_INBOUND_SYNC_INTERVAL_MS)

  if (!immediateRunScheduled) {
    immediateRunScheduled = true
    setTimeout(() => {
      immediateRunScheduled = false
      if (intervalId) {
        runEmailInboundSync('startup').catch(error => {
          logger.warn(`[Correo IMAP] Sync startup fallido: ${error.message}`)
        })
      }
    }, 1_000)
  }

  return true
}

export function stopEmailInboundSyncCron() {
  if (!intervalId) return
  clearInterval(intervalId)
  intervalId = null
  immediateRunScheduled = false
}
