import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findMatchingContactCustomField,
  getContactCustomFieldChoiceValues,
  getContactCustomFieldKeys,
  normalizeContactCustomFieldOptions,
  resolveContactCustomFieldOptions,
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

const currentChoices = [
  { label: 'Sí, tengo disponibilidad', value: 'si_disponible' },
  { label: 'No tengo disponibilidad', value: 'no_disponible' }
]
const originalChoices = [
  { label: 'Puedo invertir con financiamiento', value: 'con_financiamiento' },
  { label: 'Puedo invertir sin financiamiento', value: 'sin_financiamiento' },
  { label: 'No puedo invertir este mes', value: 'sin_inversion' }
]

test('un radio conserva marcada su respuesta original aunque el catálogo tenga otras opciones', () => {
  const field = { dataType: 'radio', value: 'con_financiamiento', options: originalChoices }
  const before = structuredClone(field)
  const options = resolveContactCustomFieldOptions(currentChoices, field)
  const selected = getContactCustomFieldChoiceValues(field.value)[0]

  assert.deepEqual(options, [...currentChoices, originalChoices[0]])
  assert.deepEqual(options.filter(option => option.value === selected), [originalChoices[0]])
  assert.deepEqual(field, before, 'consultar no debe reescribir la respuesta ni sus opciones guardadas')
})

test('conserva el texto elegido si se renombra una opción con el mismo valor', () => {
  const renamedChoices = [{ value: 'con_financiamiento', label: 'Nueva oferta' }, currentChoices[1]]
  const options = resolveContactCustomFieldOptions(renamedChoices, {
    value: 'con_financiamiento',
    options: originalChoices
  })

  assert.deepEqual(options, [originalChoices[0], currentChoices[1]])
  assert.equal(options.filter(option => option.value === 'con_financiamiento').length, 1)
})

test('checkboxes y multiselect conservan todas las selecciones históricas sin duplicarlas', () => {
  const field = {
    value: ['si_disponible', { value: 'con_financiamiento', label: 'Puedo invertir con financiamiento' }, 'con_financiamiento'],
    options: originalChoices
  }
  const options = resolveContactCustomFieldOptions(currentChoices, field)
  const selected = getContactCustomFieldChoiceValues(field.value)

  assert.deepEqual(selected, ['si_disponible', 'con_financiamiento'])
  assert.deepEqual(options.filter(option => selected.includes(option.value)), [currentChoices[0], originalChoices[0]])
})

test('una respuesta sin snapshot se mantiene visible sin adivinar una opción equivalente', () => {
  assert.deepEqual(
    resolveContactCustomFieldOptions(currentChoices, { value: 'respuesta_anterior' }),
    [...currentChoices, { value: 'respuesta_anterior', label: 'respuesta_anterior' }]
  )
  assert.deepEqual(
    resolveContactCustomFieldOptions(currentChoices, { value: { value: 'anterior', label: 'Respuesta original' } }),
    [...currentChoices, { value: 'anterior', label: 'Respuesta original' }]
  )
})

test('los campos sin respuesta no seleccionan la primera opción ni crean una respuesta', () => {
  for (const value of [undefined, null, '', [], {}]) {
    assert.deepEqual(getContactCustomFieldChoiceValues(value), [])
    assert.deepEqual(resolveContactCustomFieldOptions(currentChoices, { value }), currentChoices)
  }
  assert.deepEqual(resolveContactCustomFieldOptions(undefined, { options: originalChoices }), originalChoices)
  assert.deepEqual(
    resolveContactCustomFieldOptions([], { value: 'con_financiamiento', options: originalChoices }),
    [originalChoices[0]],
    'retirar todas las opciones no debe ocultar la respuesta ni reactivar alternativas antiguas'
  )
})

test('los valores 0 y false y los formatos legacy conservan su identidad de opción', () => {
  const options = [{ value: 0, label: 'Cero' }, { value: false, label: 'No' }, 'otra']
  assert.deepEqual(normalizeContactCustomFieldOptions(options), [
    { value: '0', label: 'Cero' }, { value: 'false', label: 'No' }, { value: 'otra', label: 'otra' }
  ])
  assert.deepEqual(getContactCustomFieldChoiceValues(0), ['0'])
  assert.deepEqual(getContactCustomFieldChoiceValues(false), ['false'])
  assert.deepEqual(getContactCustomFieldChoiceValues({ value: 0, label: 'Cero' }), ['0'])
  assert.deepEqual(getContactCustomFieldChoiceValues([{ value: false, label: 'No' }]), ['false'])
  assert.deepEqual(getContactCustomFieldChoiceValues({ value: '["opcion"]', label: 'Valor literal' }), ['["opcion"]'])
  assert.deepEqual(resolveContactCustomFieldOptions(currentChoices, { value: [0, false], options }).slice(-2), [
    { value: '0', label: 'Cero' }, { value: 'false', label: 'No' }
  ])
})

test('normaliza catálogos incompletos sin opciones duplicadas ni objetos como texto', () => {
  assert.deepEqual(normalizeContactCustomFieldOptions(null), [])
  assert.deepEqual(normalizeContactCustomFieldOptions({ value: 'no_es_lista' }), [])
  assert.deepEqual(normalizeContactCustomFieldOptions([
    null, {}, [], '', { value: 'a', label: 'Primera' }, { value: 'a', label: 'Duplicada' }, { name: 'Otra' }
  ]), [{ value: 'a', label: 'Primera' }, { value: 'Otra', label: 'Otra' }])
})
