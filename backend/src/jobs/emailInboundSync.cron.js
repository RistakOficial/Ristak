import { syncInboundEmailOnce } from '../services/emailService.js'
import { logger } from '../utils/logger.js'

const EMAIL_INBOUND_SYNC_INTERVAL_MS = 60_000

let intervalId = null
let immediateRunScheduled = false

function runEmailInboundSync(reason) {
  syncInboundEmailOnce({ reason }).catch(error => {
    logger.warn(`[Correo IMAP] Sync ${reason} fallido: ${error.message}`)
  })
}

export function startEmailInboundSyncCron() {
  if (intervalId) return true

  intervalId = setInterval(() => runEmailInboundSync('interval'), EMAIL_INBOUND_SYNC_INTERVAL_MS)

  if (!immediateRunScheduled) {
    immediateRunScheduled = true
    setTimeout(() => {
      immediateRunScheduled = false
      if (intervalId) runEmailInboundSync('startup')
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
