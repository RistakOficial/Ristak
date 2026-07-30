import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

test('Configuración muestra las pausas automáticas sólo cuando existe un QR conectado', async () => {
  const source = await readFile(
    join(testDir, '../../frontend/src/pages/Settings/WhatsAppSettings.tsx'),
    'utf8'
  )

  assert.match(source, /const hasConnectedQr = enrichedPhones\.some\(\(row\) => row\.qrConnected\)/)
  assert.match(source, /\{hasConnectedQr && renderQrDripPanel\(true\)\}/)
  assert.equal(
    source.match(/\{renderQrDripPanel\(true\)\}/g)?.length || 0,
    0,
    'el panel principal no debe renderizarse sin comprobar una conexión QR activa'
  )
})
