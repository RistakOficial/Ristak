import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('el editor no vuelve a pedir IDs que ya pertenecen a la ejecución', () => {
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const notificationStart = registry.indexOf("type: 'action-system-notification'")
  const notificationEnd = registry.indexOf("type: 'action-webhook'", notificationStart)
  const notificationDefinition = registry.slice(notificationStart, notificationEnd)

  assert.ok(notificationStart >= 0 && notificationEnd > notificationStart)
  assert.equal(notificationDefinition.includes("key: 'contactId'"), false)
  assert.equal(notificationDefinition.includes('Contacto de referencia'), false)
  for (const redundantIdentityField of [
    'contactId',
    'contact_id',
    'appointmentId',
    'appointment_id',
    'paymentId',
    'payment_id',
    'submissionId',
    'submission_id'
  ]) {
    assert.equal(
      registry.includes(`key: '${redundantIdentityField}'`),
      false,
      `El editor no debe pedir ${redundantIdentityField}; viene del contexto de ejecución`
    )
  }
})

test('Esperar usa la cita del disparador solo cuando todas las entradas entregan cita', () => {
  const waitEditor = readRepoFile(
    'frontend/src/pages/Automations/editor/config/WaitConfigEditor.tsx'
  )
  const fields = readRepoFile('frontend/src/pages/Automations/editor/crmFields.ts')
  const catalog = readRepoFile('frontend/src/pages/Automations/editor/variablesCatalog.ts')

  assert.match(waitEditor, /allTriggersProvideEventContext\(\s*flowVariables\.triggerTypes,\s*'appointment'/)
  assert.match(waitEditor, /Se usará automáticamente la cita que activó esta ejecución/)
  assert.match(fields, /triggerTypes\.every\(/)
  assert.match(catalog, /triggerTypes: reachingTriggers\.map\(\(trigger\) => trigger\.type\)/)
})
