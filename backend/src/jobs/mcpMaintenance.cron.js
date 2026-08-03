import cron from 'node-cron'
import { runMcpDataMaintenance } from '../services/mcpMaintenanceService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const MCP_MAINTENANCE_LOCK_TTL_MS = 30 * 60 * 1000
let maintenanceTask = null
let running = false

export async function runMcpMaintenance(source = 'manual') {
  if (running || isDeployShutdownStarted()) return { skipped: true, reason: 'busy_or_shutdown' }
  running = true
  try {
    return await trackDeployDrainWork('cron:mcp-maintenance', async () => {
      const locked = await withCronLock('mcp-data-maintenance', MCP_MAINTENANCE_LOCK_TTL_MS, async () => (
        runMcpDataMaintenance()
      ))
      if (!locked.ran) return { skipped: true, reason: 'locked' }
      const totals = locked.result || {}
      const changed = Object.values(totals).reduce((sum, value) => sum + Number(value || 0), 0)
      if (changed) logger.info(`[MCP] Mantenimiento ${source}: ${changed} registro(s) depurado(s).`)
      return totals
    }, source)
  } catch (error) {
    logger.error(`[MCP] Falló el mantenimiento ${source}: ${error.message}`)
    return { failed: true, error: error.message }
  } finally {
    running = false
  }
}

export function startMcpMaintenanceCron() {
  if (maintenanceTask) return
  maintenanceTask = cron.schedule('23 */6 * * *', () => {
    runMcpMaintenance('interval').catch(error => logger.error(`[MCP] Error no manejado en mantenimiento: ${error.message}`))
  })
  runMcpMaintenance('startup').catch(error => logger.error(`[MCP] Error inicial de mantenimiento: ${error.message}`))
}

export function stopMcpMaintenanceCron() {
  if (!maintenanceTask) return
  maintenanceTask.stop()
  maintenanceTask.destroy?.()
  maintenanceTask = null
}
