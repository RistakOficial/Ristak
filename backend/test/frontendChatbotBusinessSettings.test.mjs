import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readFrontend = (relativePath) => readFile(
  new URL(`../../frontend/src/${relativePath}`, import.meta.url),
  'utf8'
)

const readBackend = (relativePath) => readFile(
  new URL(`../src/${relativePath}`, import.meta.url),
  'utf8'
)

test('Chatbot conserva una pestaña funcional para editar la descripción global', async () => {
  const [chatbotSource, settingsSource, profileSource, runtimeServiceSource, runtimeRoutesSource] = await Promise.all([
    readFrontend('pages/Chatbot/Chatbot.tsx'),
    readFrontend('pages/Settings/Settings.tsx'),
    readFrontend('pages/Chatbot/ChatbotBusinessSettings.tsx'),
    readFrontend('services/aiRuntimeService.ts'),
    readBackend('routes/aiRuntime.routes.js')
  ])

  assert.match(chatbotSource, /<SegmentTabs/)
  assert.match(chatbotSource, /label: 'Configuración'/)
  assert.match(chatbotSource, /path="general"/)
  assert.match(chatbotSource, /<ChatbotBusinessSettings \/>/)
  assert.match(settingsSource, /path="artificial-intelligence"[^\n]+to="\/ai-agent\/general"/)

  assert.match(profileSource, /Descripción general del negocio/)
  assert.match(profileSource, /Usar la descripción del negocio/)
  assert.match(profileSource, /aiRuntimeService\.saveBusinessProfile\(businessContext\)/)
  assert.match(runtimeServiceSource, /method: 'PUT'/)
  assert.match(runtimeServiceSource, /'\/business-profile'/)
  assert.match(
    runtimeRoutesSource,
    /router\.put\('\/business-profile', requireModuleAccess\('ai_agent'\), saveBusinessProfile\)/
  )
})
