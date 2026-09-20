import { createHash } from 'node:crypto'
import { getAppConfig, setAppConfig } from '../config/database.js'
import { acquireDistributedLock, releaseDistributedLock, renewDistributedLock } from '../utils/distributedLock.js'
import { getOpenAIApiKey } from './aiRuntimeService.js'

export const OPENAI_MODEL_CATALOG_CONFIG_KEY = 'openai_model_catalog_v1'
export const OPENAI_MODEL_CATALOG_INTERVAL_MS = 24 * 60 * 60 * 1000

// /models also contains speech, image, embedding and specialized endpoints.
// Keep conversational families without tying discovery to today's generation.
export function selectConversationalOpenAIModels(data) {
  const ids = [...new Set((Array.isArray(data) ? data : [])
    .map((item) => String(item?.id || ''))
    .filter((id) => /^(gpt-\d|o\d(?:-|$)|chat-latest$)/.test(id))
    .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(id))
    .filter((id) => !/(audio|realtime|transcribe|tts|image|embedding|moderation|codex|search|deep-research|instruct)/i.test(id)))]
  return ids.filter((id) => {
    const alias = id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
    return alias === id || !ids.includes(alias)
  }).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

function readCache(value, credentialFingerprint) {
  try {
    const cached = JSON.parse(value || 'null')
    if (cached?.credentialFingerprint === credentialFingerprint && Array.isArray(cached.models)) return cached
  } catch { /* A damaged cache is rebuilt from the provider. */ }
  return { credentialFingerprint, models: [], checkedAt: null, refreshedAt: null, status: 'pending' }
}

function publicCatalog(cache) {
  return {
    models: cache.models,
    checkedAt: cache.checkedAt,
    refreshedAt: cache.refreshedAt,
    status: cache.status
  }
}

export function createOpenAIModelCatalogService({
  readApiKey, readStored, writeStored, acquireLock, releaseLock, renewLock,
  fetchModels, now = Date.now
}) {
  let inFlight = null
  const fingerprint = (key) => createHash('sha256').update(key).digest('hex')
  const isFresh = (cache) => cache.checkedAt !== null && now() >= cache.checkedAt &&
    now() - cache.checkedAt < OPENAI_MODEL_CATALOG_INTERVAL_MS

  async function refresh() {
    const apiKey = await readApiKey()
    if (!apiKey) return publicCatalog({ models: [], status: 'disconnected', checkedAt: null, refreshedAt: null })
    const credentialFingerprint = fingerprint(apiKey)
    let cache = readCache(await readStored(), credentialFingerprint)
    if (isFresh(cache)) return publicCatalog(cache)
    const { acquired, lock } = await acquireLock()
    if (!acquired) return publicCatalog(cache)
    let leaseValid = true
    const heartbeat = setInterval(() => {
      void renewLock(lock).then((renewed) => { if (!renewed) leaseValid = false }).catch(() => { leaseValid = false })
    }, 20_000)
    heartbeat.unref?.()
    try {
      // A different instance may have finished between the first read and lock.
      cache = readCache(await readStored(), credentialFingerprint)
      if (isFresh(cache)) return publicCatalog(cache)
      const checkedAt = now()
      try {
        const payload = await fetchModels(apiKey)
        const models = selectConversationalOpenAIModels(payload?.data)
        if (!models.length) throw new Error('empty_catalog')
        cache = { credentialFingerprint, models, checkedAt, refreshedAt: now(), status: 'ready' }
      } catch {
        // Keep the last successful list, and avoid hitting a failing API on
        // every page load. The next daily attempt can recover automatically.
        cache = { ...cache, checkedAt, status: 'unavailable' }
      }
      const currentKey = await readApiKey()
      if (!currentKey || fingerprint(currentKey) !== credentialFingerprint) {
        return publicCatalog({ models: [], status: 'pending', checkedAt: null, refreshedAt: null })
      }
      if (leaseValid) await writeStored(JSON.stringify(cache))
      return publicCatalog(cache)
    } finally {
      clearInterval(heartbeat)
      await releaseLock(lock)
    }
  }

  return {
    getCatalog() {
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null })
      return inFlight
    }
  }
}

const catalogService = createOpenAIModelCatalogService({
  readApiKey: getOpenAIApiKey,
  readStored: () => getAppConfig(OPENAI_MODEL_CATALOG_CONFIG_KEY),
  writeStored: (value) => setAppConfig(OPENAI_MODEL_CATALOG_CONFIG_KEY, value),
  acquireLock: () => acquireDistributedLock('openai-model-catalog', 120_000, { failOpen: false }),
  releaseLock: releaseDistributedLock,
  renewLock: renewDistributedLock,
  fetchModels: async (apiKey) => {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error('model_catalog_request_failed')
    return response.json()
  }
})

export async function getOpenAIModelCatalog() {
  return catalogService.getCatalog()
}
