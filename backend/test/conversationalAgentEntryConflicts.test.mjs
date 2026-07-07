import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildNewContactScopeCutoffAt,
  contactIsOutOfScopeForAgent,
  findConversationalAgentEntryConflicts
} from '../src/services/conversationalAgentService.js'

function agent(overrides = {}) {
  return {
    id: overrides.id || 'agent_test',
    name: overrides.name || 'Agente test',
    enabled: overrides.enabled !== false,
    filters: overrides.filters || { entry: { groups: [] }, exit: { groups: [] } }
  }
}

function tagFilter(tag) {
  return {
    entry: {
      groups: [{
        conditions: [{
          category: 'tags',
          params: [{ field: 'tag', operator: 'has', value: tag }]
        }]
      }]
    },
    exit: { groups: [] }
  }
}

test('detecta conflicto cuando dos agentes publicados entran con cualquier chat', () => {
  const conflicts = findConversationalAgentEntryConflicts(
    agent({ id: 'nuevo', name: 'Nuevo' }),
    [agent({ id: 'ventas', name: 'Ventas' })]
  )

  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].agentId, 'ventas')
  assert.match(conflicts[0].reason, /cualquier chat/)
})

test('permite un agente especifico aunque exista un agente amplio como respaldo', () => {
  const conflicts = findConversationalAgentEntryConflicts(
    agent({ id: 'citas', name: 'Citas', filters: tagFilter('citas') }),
    [agent({ id: 'general', name: 'General' })]
  )

  assert.equal(conflicts.length, 0)
})

test('bloquea agentes con el mismo candado de entrada por etiqueta', () => {
  const conflicts = findConversationalAgentEntryConflicts(
    agent({ id: 'citas_nuevo', name: 'Citas nuevo', filters: tagFilter('citas') }),
    [agent({ id: 'citas_actual', name: 'Citas actual', filters: tagFilter('citas') })]
  )

  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].agentName, 'Citas actual')
  assert.match(conflicts[0].reason, /etiqueta/)
})

test('permite agentes con etiquetas de entrada distintas', () => {
  const conflicts = findConversationalAgentEntryConflicts(
    agent({ id: 'ventas', name: 'Ventas', filters: tagFilter('ventas') }),
    [agent({ id: 'citas', name: 'Citas', filters: tagFilter('citas') })]
  )

  assert.equal(conflicts.length, 0)
})

test('calcula el corte de contactos nuevos al inicio del dia del negocio', () => {
  const cutoff = buildNewContactScopeCutoffAt({
    timezone: 'America/Mexico_City',
    referenceDate: new Date('2026-07-07T02:00:00.000Z')
  })

  assert.equal(cutoff, '2026-07-06T06:00:00.000Z')
})

test('new_only permite contactos creados durante el dia de negocio del corte', () => {
  const scopedAgent = {
    contactScope: 'new_only',
    contactScopeCutoffAt: '2026-07-06T06:00:00.000Z'
  }

  assert.equal(contactIsOutOfScopeForAgent(scopedAgent, {
    contactInfo: { createdAt: '2026-07-06 05:59:59' }
  }), true)

  assert.equal(contactIsOutOfScopeForAgent(scopedAgent, {
    contactInfo: { createdAt: '2026-07-06 06:00:00' }
  }), false)

  assert.equal(contactIsOutOfScopeForAgent(scopedAgent, {
    contactInfo: { createdAt: '2026-07-06 14:00:06.247' }
  }), false)
})
