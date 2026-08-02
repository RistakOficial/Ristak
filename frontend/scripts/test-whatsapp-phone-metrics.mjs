import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/whatsappPhoneMetrics.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  }
}).outputText
const moduleUrl = `${pathToFileURL(sourceUrl.pathname).href}.test.mjs`
const metricsModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(`${transpiled}\n//# sourceURL=${moduleUrl}`)}`)
const { getWhatsAppMessagingLimitLabel, getWhatsAppQualityLabel } = metricsModule

assert.equal(getWhatsAppQualityLabel({ provider: 'qr', status: 'QR_ONLY' }), 'No aplica')
assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'qr', status: 'QR_ONLY' }), 'No aplica')

assert.equal(getWhatsAppQualityLabel({ provider: 'meta_direct', quality_rating: 'GREEN' }), 'Alta')
assert.equal(getWhatsAppQualityLabel({ provider: 'ycloud', quality_rating: 'yellow' }), 'Media')
assert.equal(getWhatsAppQualityLabel({ provider: 'meta_direct', quality_rating: 'NA' }), 'Aún sin calificación')
assert.equal(getWhatsAppQualityLabel({ provider: 'meta_direct' }), 'No disponible')

assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'meta_direct', messaging_limit: 'TIER_250' }), '250 clientes / 24 h')
assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'meta_direct', messaging_limit: 'TIER_2K' }), '2,000 clientes / 24 h')
assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'meta_direct', messaging_limit: 'TIER_UNLIMITED' }), 'Ilimitado')
assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'meta_direct', messaging_limit: 'UNTIERED' }), 'Sin nivel asignado')
assert.equal(getWhatsAppMessagingLimitLabel({ provider: 'meta_direct' }), 'No disponible')

console.log('WhatsApp phone metrics tests passed')
