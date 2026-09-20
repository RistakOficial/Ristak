import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOpenAIModelCatalogService,
  OPENAI_MODEL_CATALOG_INTERVAL_MS,
  selectConversationalOpenAIModels
} from '../src/services/openAIModelCatalogService.js'

function fixture() {
  const state = { key: 'catalog-test-connection', stored: null, calls: 0, time: 100, fail: false, acquired: true }
  const dependencies = {
    readApiKey: async () => state.key,
    readStored: async () => state.stored,
    writeStored: async (value) => { state.stored = value },
    acquireLock: async () => ({ acquired: state.acquired, lock: {} }),
    releaseLock: async () => {},
    renewLock: async () => true,
    now: () => state.time,
    fetchModels: async () => {
      state.calls++
      if (state.fail) throw new Error('provider unavailable')
      return { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-luna' }] }
    }
  }
  return { state, dependencies, service: createOpenAIModelCatalogService(dependencies) }
}

test('descubre generaciones nuevas, excluye modalidades especializadas y deduplica snapshots', () => {
  assert.deepEqual(selectConversationalOpenAIModels([
    'gpt-6-astra', 'gpt-6-astra-2026-09-01', 'gpt-6-astra', 'gpt-7-future',
    'gpt-4o-mini', 'gpt-4o-audio-preview', 'gpt-image-2', 'gpt-5.3-codex',
    'text-embedding-3-small', 'o3-deep-research', 'whisper-1', 'gpt-3.5-turbo-instruct'
  ].map((id) => ({ id }))), ['gpt-7-future', 'gpt-6-astra', 'gpt-4o-mini'])
})

test('una consulta compartida por 24 horas, incluso después de reiniciar el servicio', async () => {
  const { state, dependencies, service } = fixture()
  const results = await Promise.all([service.getCatalog(), service.getCatalog(), service.getCatalog()])
  assert.equal(state.calls, 1)
  assert.ok(results.every((result) => result.models.includes('gpt-6-astra')))
  assert.equal(results[0].credentialFingerprint, undefined)
  assert.ok(!state.stored.includes(state.key))
  await createOpenAIModelCatalogService(dependencies).getCatalog()
  assert.equal(state.calls, 1)
  state.time += OPENAI_MODEL_CATALOG_INTERVAL_MS
  await service.getCatalog()
  assert.equal(state.calls, 2)
})

test('fallos conservan la última lista y no disparan llamadas por cada visita', async () => {
  const { state, service } = fixture()
  const initial = await service.getCatalog()
  state.time += OPENAI_MODEL_CATALOG_INTERVAL_MS
  state.fail = true
  const failed = await service.getCatalog()
  assert.equal(failed.status, 'unavailable')
  assert.deepEqual(failed.models, initial.models)
  assert.equal(failed.refreshedAt, initial.refreshedAt)
  await service.getCatalog()
  assert.equal(state.calls, 2)
  state.fail = false
  state.time += OPENAI_MODEL_CATALOG_INTERVAL_MS
  assert.equal((await service.getCatalog()).status, 'ready')
})

test('otra conexión no hereda el catálogo aunque falle y una desconectada no consulta', async () => {
  const { state, service } = fixture()
  await service.getCatalog()
  state.key = 'different-test-connection'
  state.fail = true
  assert.deepEqual((await service.getCatalog()).models, [])
  state.key = null
  assert.equal((await service.getCatalog()).status, 'disconnected')
  assert.equal(state.calls, 2)
})

test('respeta el lock de otra instancia y descarta resultados si cambia la conexión', async () => {
  const { state, dependencies } = fixture()
  state.acquired = false
  await createOpenAIModelCatalogService(dependencies).getCatalog()
  assert.equal(state.calls, 0)
  state.acquired = true
  dependencies.fetchModels = async () => {
    state.key = 'changed-during-request'
    return { data: [{ id: 'gpt-6-astra' }] }
  }
  assert.deepEqual((await createOpenAIModelCatalogService(dependencies).getCatalog()).models, [])
  assert.equal(state.stored, null)
})
