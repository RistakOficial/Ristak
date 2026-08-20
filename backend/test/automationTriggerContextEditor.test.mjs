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
  const editor = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.tsx')

  assert.match(waitEditor, /allTriggersProvideEventContext\(\s*flowVariables\.triggerTypes,\s*'appointment'/)
  assert.match(waitEditor, /Se usará automáticamente la cita que activó esta ejecución/)
  assert.match(waitEditor, /getNextDownstreamWaitNode\(nodes, edges, currentNodeId\)/)
  assert.match(waitEditor, /Saltar al siguiente evento de espera/)
  assert.match(waitEditor, /¿Qué quieres que pase si ya pasó el tiempo\? \(obligatorio\)/)
  assert.match(waitEditor, /placeholder="Elige qué debe pasar"/)
  assert.match(waitEditor, /configuredPastDueAction === 'auto'/)
  assert.match(waitEditor, /nextDownstreamWait \? 'next_wait' : ''/)
  assert.match(fields, /triggerTypes\.every\(/)
  assert.match(catalog, /triggerTypes: reachingTriggers\.map\(\(trigger\) => trigger\.type\)/)
  const waitStart = registry.indexOf("type: 'logic-wait'")
  const waitEnd = registry.indexOf("type: 'logic-goal'", waitStart)
  const waitDefinition = registry.slice(waitStart, waitEnd)
  assert.match(waitDefinition, /appointmentPastDueAction: 'auto'/)
  assert.match(waitDefinition, /\{ id: 'out', label: 'Llegó el momento' \}/)
  assert.doesNotMatch(waitDefinition, /\{ id: 'cancelled', label: 'Cita cancelada' \}/)
  assert.match(editor, /validateAppointmentPastDueChoicesForSave\(/)
  assert.match(editor, /'No se pudo guardar'/)
  assert.match(editor, /edges: pruneInvalidEdges\(migratedNodes, edges\)/)
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

test('Contacto modificado vigila los campos elegidos sin pedir Detalle que cambió', () => {
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const fields = readRepoFile('frontend/src/pages/Automations/editor/crmFields.ts')
  const filtersEditor = readRepoFile(
    'frontend/src/pages/Automations/editor/config/TriggerFiltersEditor.tsx'
  )
  const nodeBubble = readRepoFile('frontend/src/pages/Automations/editor/NodeConfigBubble.tsx')

  assert.match(fields, /id: 'changed_detail',[\s\S]*hiddenFromPicker: true/)
  assert.match(fields, /contactChangedFiltersForEditor/)
  assert.match(filtersEditor, /if \(field\.hiddenFromPicker\) return/)
  assert.match(filtersEditor, /Cada campo que agregues queda vigilado automáticamente/)
  assert.match(filtersEditor, /Añadir campo vigilado/)
  assert.match(filtersEditor, /Selecciona el campo que debe cambiar/)
  assert.match(nodeBubble, /contactChangedFiltersForEditor\(config\.filters\)/)

  const triggerStart = registry.indexOf("type: 'trigger-contact-updated'")
  const triggerEnd = registry.indexOf("type: 'trigger-contact-created'", triggerStart)
  const definition = registry.slice(triggerStart, triggerEnd)
  assert.ok(triggerStart >= 0 && triggerEnd > triggerStart)
  assert.match(definition, /Vigila automáticamente los campos configurados/)
  assert.match(definition, /contactChangedTriggerLead\(filters\)/)
})

test('los dos disparadores de cita ofrecen el filtro Agendado por con valores cerrados', () => {
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const fields = readRepoFile('frontend/src/pages/Automations/editor/crmFields.ts')

  assert.match(fields, /id: 'booking_origin'/)
  assert.match(fields, /label: 'Agendado por'/)
  assert.match(fields, /value: 'contact', label: 'Contacto'/)
  assert.match(fields, /value: 'admin', label: 'Admin'/)
  assert.match(fields, /value: 'public_calendar', label: 'Calendario público'/)
  assert.match(fields, /id: 'booking_origin',[\s\S]*operators: \['is', 'not'\],[\s\S]*appliesTo: \['appointment'\]/)
  assert.match(fields, /'trigger-appointment-booked': \['appointment'\]/)
  assert.match(fields, /'trigger-appointment-status': \['appointment'\]/)

  const bookedStart = registry.indexOf("type: 'trigger-appointment-booked'")
  const bookedEnd = registry.indexOf("type: 'trigger-payment-received'", bookedStart)
  const bookedDefinition = registry.slice(bookedStart, bookedEnd)
  assert.ok(bookedStart >= 0 && bookedEnd > bookedStart)
  assert.match(bookedDefinition, /label: 'Cita agendada'/)
  assert.match(bookedDefinition, /Cuando se agende una cita/)
  assert.doesNotMatch(bookedDefinition, /Cuando el contacto agende una cita/)
})

test('Confirmar cita muestra la espera de respuesta como configuración principal y separada del envío', () => {
  const registry = readRepoFile('frontend/src/pages/Automations/editor/nodeRegistry.tsx')
  const confirmationStart = registry.indexOf("type: 'action-appointment-confirmation'")
  const confirmationEnd = registry.indexOf("type: 'extra-comment'", confirmationStart)
  const definition = registry.slice(confirmationStart, confirmationEnd)

  assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart)
  assert.match(definition, /label: 'Tiempo para enviar la solicitud'/)
  assert.match(definition, /label: 'Tiempo de espera para confirmar'/)
  assert.match(definition, /label: 'Unidad de la espera'/)
  assert.match(definition, /label: 'Cómo contar la espera'/)
  assert.match(definition, /label: 'El contador corre desde'/)
  assert.match(definition, /label: 'El contador corre hasta'/)
  assert.match(definition, /Ristak aplica esta acción únicamente cuando termina la espera/)
  assert.match(definition, /espera \$\{timeoutValue\}/)

  const deadlineStart = definition.indexOf("key: 'noConfirmAction'")
  const deadlineEnd = definition.indexOf("key: 'confirmationReplyText'", deadlineStart)
  const visibleDeadlineFields = definition.slice(deadlineStart, deadlineEnd)
  assert.ok(deadlineStart >= 0 && deadlineEnd > deadlineStart)
  assert.doesNotMatch(visibleDeadlineFields, /advanced: true/)
  assert.ok(
    visibleDeadlineFields.indexOf("key: 'confirmationTimeoutValue'") <
      visibleDeadlineFields.indexOf("key: 'confirmationTimeoutMode'")
  )
  assert.match(
    visibleDeadlineFields,
    /confirmationTimeoutMode\) \|\| 'response_window'\) === 'response_window'/
  )
})
