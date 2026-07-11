import { runYCloudHistoryBackfillBatch } from '../services/whatsappApiService.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const BOOT_DELAY_MS = 5_000
const BACKFILL_INTERVAL_MS = 15_000
const PAGES_PER_TICK = 3

let started = false
let running = false
let bootTimeoutId = null
let intervalId = null

async function runBackfillTick(reason) {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    if (!(await canRunBackgroundJob('whatsapp'))) return

    const locked = await trackDeployDrainWork(
      'cron:whatsapp-api-history-backfill',
      () => withCronLock(
        'whatsapp-api-history-backfill',
        BACKFILL_INTERVAL_MS,
        () => runYCloudHistoryBackfillBatch({ maxPages: PAGES_PER_TICK })
      ),
      reason
    )
    const result = locked?.result
    if (result?.completed) {
      logger.success(`[WhatsApp API] Backfill YCloud completado (${result.messages} mensajes en el último lote).`)
    }
  } catch (error) {
    logger.warn(`[WhatsApp API] Backfill YCloud ${reason} falló: ${error.message}`)
  } finally {
    running = false
  }
}

export function startWhatsAppApiHistoryBackfillCron() {
  if (started) return
  started = true

  bootTimeoutId = setTimeout(() => {
    runBackfillTick('startup')
  }, BOOT_DELAY_MS)
  intervalId = setInterval(() => {
    runBackfillTick('tick')
  }, BACKFILL_INTERVAL_MS)
  bootTimeoutId.unref?.()
  intervalId.unref?.()
  return true
}

export function stopWhatsAppApiHistoryBackfillCron() {
  if (bootTimeoutId) clearTimeout(bootTimeoutId)
  if (intervalId) clearInterval(intervalId)
  bootTimeoutId = null
  intervalId = null
  started = false
  running = false
}
