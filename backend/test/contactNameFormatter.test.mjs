import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatContactName,
  normalizeContactNameFields,
  splitContactName
} from '../src/utils/contactNameFormatter.js'

test('formatContactName normaliza mayusculas y minusculas mezcladas', () => {
  assert.equal(formatContactName('raul gomez'), 'Raul Gomez')
  assert.equal(formatContactName('rAuL GomEZ'), 'Raul Gomez')
  assert.equal(formatContactName('  RAUL   GOMEZ  '), 'Raul Gomez')
})

test('formatContactName conserva conectores comunes en medio del nombre', () => {
  assert.equal(formatContactName('ana maria DE LA cruz'), 'Ana Maria de la Cruz')
  assert.equal(formatContactName('DE la cruz'), 'De la Cruz')
})

test('formatContactName soporta nombres compuestos con guion y apostrofo', () => {
  assert.equal(formatContactName("maria-jose o'connor"), "Maria-Jose O'Connor")
  assert.equal(formatContactName('jean-luc d\u2019angelo'), 'Jean-Luc D\u2019Angelo')
})

test('formatContactName no modifica emails, telefonos ni handles usados como fallback', () => {
  assert.equal(formatContactName('cliente@example.com'), 'cliente@example.com')
  assert.equal(formatContactName('+52 656 742 6612'), '+52 656 742 6612')
  assert.equal(formatContactName('@raulgo'), '@raulgo')
})

test('splitContactName devuelve nombre y apellidos ya formateados', () => {
  assert.deepEqual(splitContactName('rAuL GomEZ loPeZ'), {
    firstName: 'Raul',
    lastName: 'Gomez Lopez'
  })
})

test('normalizeContactNameFields prioriza nombres explicitos formateados', () => {
  assert.deepEqual(normalizeContactNameFields({
    fullName: 'rAuL GomEZ',
    firstName: 'raUl'
  }), {
    fullName: 'Raul Gomez',
    firstName: 'Raul',
    lastName: 'Gomez'
  })

  assert.deepEqual(normalizeContactNameFields({
    firstName: 'ana',
    lastName: 'DE LA cruz'
  }), {
    fullName: 'Ana de la Cruz',
    firstName: 'Ana',
    lastName: 'de la Cruz'
  })
})
