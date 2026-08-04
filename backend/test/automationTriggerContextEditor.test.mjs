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
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const waitEditor = readRepoFile(
    'frontend/src/pages/Automations/editor/config/WaitConfigEditor.tsx'
  )
  const fields = readRepoFile('frontend/src/pages/Automations/editor/crmFields.ts')
  const catalog = readRepoFile('frontend/src/pages/Automations/editor/variablesCatalog.ts')

  assert.match(waitEditor, /allTriggersProvideEventContext\(\s*flowVariables\.triggerTypes,\s*'appointment'/)
  assert.match(waitEditor, /Se usará automáticamente la cita que activó esta ejecución/)
  assert.match(fields, /triggerTypes\.every\(/)
  assert.match(catalog, /triggerTypes: reachingTriggers\.map\(\(trigger\) => trigger\.type\)/)
  assert.match(registry, /\{ id: 'out', label: 'Llegó el momento' \}/)
  assert.match(registry, /\{ id: 'cancelled', label: 'Cita cancelada' \}/)
})

test('el catálogo global ofrece el enlace seguro de la cita en correos y mensajes', () => {
  const catalog = readRepoFile('frontend/src/pages/Automations/editor/variablesCatalog.ts')
  const emailEditor = readRepoFile(
    'frontend/src/pages/Automations/editor/config/EmailConfigEditor.tsx'
  )

  assert.match(
    catalog,
    /fieldId: 'cita\.enlace_ingreso', label: 'Enlace de ingreso a la cita', category: 'appointment'/
  )
  assert.match(emailEditor, /loadAllVariables\(\)/)
  assert.match(emailEditor, /variables: richEditorVariables/)
})

test('Formulario enviado elige el formulario dentro de filtros y no en un campo separado', () => {
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const fields = readRepoFile('frontend/src/pages/Automations/editor/crmFields.ts')
  const filtersEditor = readRepoFile(
    'frontend/src/pages/Automations/editor/config/TriggerFiltersEditor.tsx'
  )
  const nodeBubble = readRepoFile('frontend/src/pages/Automations/editor/NodeConfigBubble.tsx')
  const automationEditor = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.tsx')
  const variablesCatalog = readRepoFile('frontend/src/pages/Automations/editor/variablesCatalog.ts')

  const triggerStart = registry.indexOf("type: 'trigger-form-submitted'")
  const triggerEnd = registry.indexOf("type: 'trigger-whatsapp-message'", triggerStart)
  const triggerDefinition = registry.slice(triggerStart, triggerEnd)
  assert.ok(triggerStart >= 0 && triggerEnd > triggerStart)
  assert.match(triggerDefinition, /defaultConfig: \(\) => \(\{ filters: \[\] \}\)/)
  assert.match(triggerDefinition, /fields: \[\]/)
  assert.doesNotMatch(triggerDefinition, /Formulario que dispara el evento/)

  const specificIndex = fields.indexOf("id: 'form-specific'", fields.indexOf('TRIGGER_FILTER_FIELDS'))
  const resultIndex = fields.indexOf("id: 'form_disqualified'", specificIndex)
  const questionIndex = fields.indexOf("id: 'form_field'", resultIndex)
  assert.ok(specificIndex >= 0)
  assert.ok(specificIndex < resultIndex && resultIndex < questionIndex)
  assert.match(filtersEditor, /next === 'form-specific' \? 'is' : ''/)
  assert.match(filtersEditor, /aria-label="Formulario específico"/)
  assert.match(filtersEditor, /Primero añade el filtro “Formulario específico”/)

  assert.match(nodeBubble, /triggerFiltersWithLegacyForm\(config\)/)
  assert.match(automationEditor, /specificFormFromConfig\(trigger\.config\)/)
  assert.match(variablesCatalog, /specificFormFromConfig\(config\)/)
})
