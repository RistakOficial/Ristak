import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate, filtersMatch, evaluateConditionNode } from '../src/services/automationEngine.js'

const ctx = {
  contact: {
    firstName: 'María',
    lastName: 'López',
    fullName: 'María López',
    phone: '+5215511223344',
    email: 'maria@test.com',
    source: 'Facebook',
    customFields: { ciudad: 'CDMX', tags: ['cliente'] },
    tags: ['cliente']
  },
  messageText: 'Hola, quiero el precio por favor',
  channel: 'whatsapp'
}

test('renderTemplate reemplaza variables del contacto y la conversación', () => {
  assert.equal(renderTemplate('Hola {{contact.first_name}}!', ctx), 'Hola María!')
  assert.equal(renderTemplate('Dijiste: {{conversation.last_message}}', ctx), 'Dijiste: Hola, quiero el precio por favor')
  assert.equal(renderTemplate('{{contact.custom.ciudad}}', ctx), 'CDMX')
  assert.equal(renderTemplate('{{desconocida.x}}', ctx), '')
})

test('filtersMatch: coincide / NO coincide / contiene / NO contiene', () => {
  assert.equal(filtersMatch([{ field: 'source', match: 'is', value: 'facebook' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'source', match: 'not', value: 'Facebook' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'message', match: 'contains', value: 'PRECIO' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'message', match: 'not_contains', value: 'precio' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'custom', customKey: 'ciudad', match: 'is', value: 'cdmx' }], ctx), true)
  // Un filtro incompleto (sin campo) se ignora: por sí solo no bloquea
  assert.equal(filtersMatch([{ field: '', match: 'is', value: 'x' }], ctx), true)
  // Un campo del evento sin dato en este contexto (p. ej. calendario en un
  // mensaje) no bloquea: se trata como desconocido
  assert.equal(filtersMatch([{ field: 'calendar', match: 'is', value: 'x' }], ctx), true)
  // Un campo de contacto reconocido cuyo valor no coincide sí bloquea
  assert.equal(filtersMatch([{ field: 'stage', match: 'is', value: 'x' }], ctx), false)
})

test('evaluateConditionNode: una rama → Sí/No', () => {
  const config = {
    branches: [
      {
        name: 'Interesado',
        groupsOperator: 'AND',
        groups: [{ operator: 'AND', negate: false, rules: [{ field: 'conv-keyword', operator: 'contains', value: 'precio' }] }]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { ...ctx, messageText: 'gracias' }).handle, 'no')
})

test('evaluateConditionNode: multi-rama elige la primera que cumple, si no "none"', () => {
  const config = {
    branches: [
      { id: 'b1', name: 'Por email', groups: [{ operator: 'AND', rules: [{ field: 'contact-email', operator: 'contains', value: '@otro.com' }] }] },
      { id: 'b2', name: 'Facebook', groups: [{ operator: 'AND', rules: [{ field: 'contact-source', operator: 'is', value: 'facebook' }] }] }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'b2')
  const none = evaluateConditionNode(config, { ...ctx, contact: { ...ctx.contact, source: 'Google', email: 'a@b.c' } })
  assert.equal(none.handle, 'none')
})

test('evaluateConditionNode: grupo negado y operador OR', () => {
  const config = {
    branches: [
      {
        name: 'Regla',
        groupsOperator: 'AND',
        groups: [
          { operator: 'OR', negate: false, rules: [
            { field: 'contact-first-name', operator: 'is', value: 'Pedro' },
            { field: 'contact-first-name', operator: 'is', value: 'María' }
          ] },
          { operator: 'AND', negate: true, rules: [{ field: 'contact-source', operator: 'is', value: 'Google' }] }
        ]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
})

test('filtersMatch: conector O entre filtros', () => {
  const filters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'or' }
  ]
  assert.equal(filtersMatch(filters, ctx), true) // fuente falla pero mensaje sí (O)
  const andFilters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'and' }
  ]
  assert.equal(filtersMatch(andFilters, ctx), false)
})
