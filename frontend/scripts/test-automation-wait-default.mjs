import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const registrySource = await readFile(
  new URL('../src/pages/Automations/editor/nodeRegistry.tsx', import.meta.url),
  'utf8'
)

const waitDefinitionStart = registrySource.indexOf("type: 'logic-wait'")
const nextDefinitionStart = registrySource.indexOf("type: 'logic-drip'", waitDefinitionStart)

assert.ok(waitDefinitionStart >= 0, 'debe existir la definición del bloque Esperar')
assert.ok(nextDefinitionStart > waitDefinitionStart, 'debe poder aislarse la definición del bloque Esperar')

const waitDefinition = registrySource.slice(waitDefinitionStart, nextDefinitionStart)

test('un bloque Esperar nuevo inicia con una espera de un minuto', () => {
  assert.match(
    waitDefinition,
    /\/\/ periodo establecido\s+amount:\s*1,\s+unit:\s*'minutes',/,
    'el periodo inicial debe ser 1 minuto'
  )
})
