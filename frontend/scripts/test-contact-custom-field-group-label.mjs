import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveContactCustomFieldGroup } from '../src/utils/contactCustomFields.ts'

test('muestra el grupo heredado general como Campos personalizados', () => {
  assert.deepEqual(
    resolveContactCustomFieldGroup('general', null),
    { id: 'unfiled', label: 'Campos personalizados' }
  )
  assert.deepEqual(
    resolveContactCustomFieldGroup(' GENERAL ', 'legacy-general'),
    { id: 'unfiled', label: 'Campos personalizados' }
  )
})

test('conserva el nombre y la identidad de las carpetas reales', () => {
  assert.deepEqual(
    resolveContactCustomFieldGroup('Ventas', 'folder-sales'),
    { id: 'folder-sales', label: 'Ventas' }
  )
  assert.deepEqual(
    resolveContactCustomFieldGroup('', null, 'Datos adicionales'),
    { id: 'unfiled', label: 'Datos adicionales' }
  )
})
