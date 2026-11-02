import { recoverDurableConversationalAgentWork } from '../agents/conversational/runner.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { logger } from '../utils/logger.js'

// Job de sistema: despierta obligaciones locales persistidas de todos los
// canales. No consulta conexiones/proveedores ni descubre backlog histórico.
export function createConversationalAgentRecoveryScheduler({
  recover = recoverDurableConversationalAgentWork,
  allowed = () => canRunBackgroundJob('conversational_ai'),
  withLock = withCronLock,
  trackWork = trackDeployDrainWork,
  shuttingDown = isDeployShutdownStarted,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = Date.now,
  reportError = error => logger.error(`[Agente] Error recuperando trabajo durable: ${error.message}`)
} = {}) {
  let intervalId = null
  let running = false
  let stopped = false
  let cursor = ''

  async function tick() {
    if (running || stopped || shuttingDown()) return { skipped: true }
    running = true
    try {
      if (!(await allowed())) return { skipped: true, reason: 'license_blocked' }
      if (stopped || shuttingDown()) return { skipped: true, reason: 'shutdown' }
      return await trackWork('cron:conversational-agent-recovery', async () => {
        const locked = await withLock('conversational-agent-recovery', 60_000, async ({ isLeaseValid = () => true } = {}) => {
          const result = await recover({ nowMs: now(), limit: 100, cursor }, {
            canContinue: () => !stopped && !shuttingDown() && isLeaseValid()
          })
          cursor = result.nextCursor || ''
          return result
        }, { failOpen: false })
        return locked.ran ? locked.result : { skipped: true, reason: 'locked' }
      })
    } finally {
      running = false
    }
  }

  function start() {
    if (intervalId) return
    stopped = false
    intervalId = setIntervalFn(() => { tick().catch(reportError) }, 30_000)
    intervalId?.unref?.()
    logger.info('[Agente conversacional] Recuperación de turnos durables activa cada 30s')
    tick().catch(reportError)
  }

  function stop() {
    stopped = true
    if (intervalId) clearIntervalFn(intervalId)
    intervalId = null
  }

  return { tick, start, stop }
}

const scheduler = createConversationalAgentRecoveryScheduler()
export const runConversationalAgentRecovery = () => scheduler.tick()
export const startConversationalAgentRecoveryCron = () => scheduler.start()
export const stopConversationalAgentRecoveryCron = () => scheduler.stop()
