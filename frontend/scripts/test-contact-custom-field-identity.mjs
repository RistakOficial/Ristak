import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findMatchingContactCustomField,
  getContactCustomFieldKeys,
  selectContactCustomFieldDefinitionsForContact
} from '../src/utils/contactCustomFields.ts'

const repeatedLabel = 'Elige la opción correspondiente.'

const definitions = [
  { definitionId: 'field-stage', key: 'etapa', fieldKey: 'etapa', label: repeatedLabel },
  { definitionId: 'field-budget', key: 'presupuesto', fieldKey: 'presupuesto', label: repeatedLabel },
  { definitionId: 'field-commitment', key: 'compromiso', fieldKey: 'compromiso', label: repeatedLabel }
]

const values = [
  { id: 'field-stage', definitionId: 'field-stage', key: 'etapa', fieldKey: 'etapa', label: repeatedLabel, value: 'Lanzando música' },
  { id: 'field-budget', definitionId: 'field-budget', key: 'presupuesto', fieldKey: 'presupuesto', label: repeatedLabel, value: '3000' },
  { id: 'field-commitment', definitionId: 'field-commitment', key: 'compromiso', fieldKey: 'compromiso', label: repeatedLabel, value: 'Estoy comprometido' }
]

test('prioriza la identidad estable cuando varias preguntas comparten etiqueta', () => {
  assert.equal(findMatchingContactCustomField(values, definitions[0])?.value, 'Lanzando música')
  assert.equal(findMatchingContactCustomField(values, definitions[1])?.value, '3000')
  assert.equal(findMatchingContactCustomField(values, definitions[2])?.value, 'Estoy comprometido')
})

test('no mezcla columnas distintas por una etiqueta repetida', () => {
  assert.deepEqual(getContactCustomFieldKeys(definitions[0]), ['field-stage', 'etapa'])
  assert.deepEqual(getContactCustomFieldKeys(definitions[1]), ['field-budget', 'presupuesto'])
  assert.deepEqual(getContactCustomFieldKeys(definitions[2]), ['field-commitment', 'compromiso'])
})

test('usa la etiqueta solo como compatibilidad legacy y exige una coincidencia única', () => {
  assert.equal(
    findMatchingContactCustomField([{ label: 'Instagram', value: '@artista' }], { label: 'Instagram' })?.value,
    '@artista'
  )
  assert.equal(
    findMatchingContactCustomField([
      { label: repeatedLabel, value: 'uno' },
      { label: repeatedLabel, value: 'dos' }
    ], { label: repeatedLabel }),
    null
  )
})

const sharedQuestion = {
  sourceFormId: 'form-adrian',
  sourceFieldId: 'question-reto'
}

const historicalQuestionDefinitions = [
  {
    definitionId: 'field-reto',
    key: 'reto',
    fieldKey: 'reto',
    label: 'Reto',
    updatedAt: '2026-07-28T12:45:07.036Z',
    ...sharedQuestion
  },
  {
    definitionId: 'field-resultado',
    key: 'resultado',
    fieldKey: 'resultado',
    label: 'Resultado',
    updatedAt: '2026-08-09T11:02:48.052Z',
    ...sharedQuestion
  }
]

const selectedKeys = (definitions, fields) => (
  selectContactCustomFieldDefinitionsForContact(definitions, fields).map(field => field.fieldKey)
)

test('muestra la variante poblada cuando una pregunta cambio de destino', () => {
  assert.deepEqual(
    selectedKeys(historicalQuestionDefinitions, [{ fieldKey: 'resultado', value: 'Quiero crecer' }]),
    ['resultado']
  )
  assert.deepEqual(
    selectedKeys(historicalQuestionDefinitions, [{ fieldKey: 'reto', value: 'Conseguir audiencia' }]),
    ['reto']
  )
})

test('conserva ambas variantes si ambas tienen respuestas historicas', () => {
  assert.deepEqual(
    selectedKeys(historicalQuestionDefinitions, [
      { fieldKey: 'reto', value: 'Respuesta anterior' },
      { fieldKey: 'resultado', value: 'Respuesta actual' }
    ]),
    ['reto', 'resultado']
  )
})

test('usa la definicion mas reciente si ninguna variante tiene respuesta', () => {
  assert.deepEqual(selectedKeys(historicalQuestionDefinitions, []), ['resultado'])
  assert.deepEqual(
    selectedKeys(historicalQuestionDefinitions, [{ fieldKey: 'reto', value: '' }]),
    ['resultado']
  )
})

test('oculta recuperaciones vacias sin curar pero conserva sus datos historicos', () => {
  const recoveryDefinition = {
    definitionId: 'field-varias',
    key: 'varias_opciones',
    fieldKey: 'varias_opciones',
    label: 'varias_opciones',
    sourceType: 'submission_recovery',
    fieldGroup: 'general'
  }

  assert.deepEqual(selectedKeys([recoveryDefinition], []), [])
  assert.deepEqual(
    selectedKeys([recoveryDefinition], [{ fieldKey: 'varias_opciones', value: '' }]),
    []
  )
  assert.deepEqual(
    selectedKeys([recoveryDefinition], [{ fieldKey: 'varias_opciones', value: ['Represento varios artistas'] }]),
    ['varias_opciones']
  )
  assert.deepEqual(
    selectedKeys([{ ...recoveryDefinition, folderId: 'folder-historico' }], []),
    ['varias_opciones']
  )
})
