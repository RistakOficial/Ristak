import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findMatchingContactCustomField,
  getContactCustomFieldKeys
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
