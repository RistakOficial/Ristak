import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectWhatsAppAttributionFields,
  extractRistakAdIdFromText
} from '../src/utils/whatsappAttribution.js'

test('extracts Ristak ad id only from the rstkad_id marker terminated by bang', () => {
  assert.equal(
    extractRistakAdIdFromText('Hola me gustaria saber costos rstkad_id=3434597816743! mi numero es 5551234567'),
    '3434597816743'
  )
  assert.equal(extractRistakAdIdFromText('Hola 5551234567 sin marcador'), '')
  assert.equal(extractRistakAdIdFromText('Hola rstkad_id=3434597816743 sin cierre'), '')
})

test('uses Ristak ad id marker as WhatsApp ad attribution fallback', () => {
  const detected = detectWhatsAppAttributionFields({}, [
    'Hola me gustaria saber costos RSTKAD_ID=3434597816743!'
  ])

  assert.equal(detected.sourceId, '3434597816743')
  assert.equal(detected.sourceType, 'ad')
})
