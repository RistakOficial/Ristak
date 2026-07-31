import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/whatsappConnectionStatus.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  }
}).outputText
const moduleUrl = `${pathToFileURL(sourceUrl.pathname).href}.test.mjs`
const statusModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(`${transpiled}\n//# sourceURL=${moduleUrl}`)}`)
const { getWhatsAppOfficialConnectionStatus } = statusModule

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'meta_direct',
    phoneStatus: 'CONNECTED',
    apiEnabled: true,
    standaloneQr: false
  }),
  { label: 'API de Meta conectada', variant: 'success' }
)

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'meta_direct',
    phoneStatus: 'AUTHORIZATION_REQUIRED',
    apiEnabled: false,
    standaloneQr: false
  }),
  { label: 'Reconectar Meta', variant: 'warning' }
)

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'meta_direct',
    phoneStatus: 'CONNECTED',
    apiEnabled: false,
    standaloneQr: false,
    needsMetaReconnect: true
  }),
  { label: 'Reconectar Meta', variant: 'warning' }
)

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'ycloud',
    apiEnabled: true,
    standaloneQr: false
  }),
  { label: 'YCloud conectado', variant: 'success' }
)

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'ycloud',
    apiEnabled: false,
    standaloneQr: false
  }),
  { label: 'YCloud desconectado', variant: 'neutral' }
)

assert.deepEqual(
  getWhatsAppOfficialConnectionStatus({
    provider: 'qr',
    apiEnabled: false,
    standaloneQr: true
  }),
  { label: 'Sin API oficial', variant: 'neutral' }
)

console.log('WhatsApp official connection status tests passed')
