import { getOpenAIModelCatalog } from '../services/openAIModelCatalogService.js'
import { isOpenAIConnected } from '../services/integrationConnectionStateService.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { logger } from '../utils/logger.js'

let timer = null

async function tick() {
  if (isDeployShutdownStarted()) return
  try {
    if (!(await isOpenAIConnected()) || !(await canRunBackgroundJob('ai_agent'))) return
    await trackDeployDrainWork('cron:openai-model-catalog', getOpenAIModelCatalog, 'daily-catalog')
  } catch {
    logger.warn('[OpenAI] No se pudo actualizar el catálogo de modelos; se conserva la última lista.')
  }
}

export function startOpenAIModelCatalogCron() {
  if (timer) return
  // The persistent 24h check lives in the service. Hourly local checks recover
  // after downtime without making hourly requests to OpenAI.
  timer = setInterval(() => void tick(), 60 * 60 * 1000)
  timer.unref?.()
  void tick()
}

export function stopOpenAIModelCatalogCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
