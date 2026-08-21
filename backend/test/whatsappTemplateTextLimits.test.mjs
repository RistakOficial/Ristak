import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countWhatsAppTemplateCharacters,
  fitWhatsAppTemplateHeaderParameters,
  WHATSAPP_TEMPLATE_TEXT_HEADER_MAX_LENGTH
} from '../src/services/whatsappTemplateTextLimits.js'

function renderHeader(templateText, parameters = []) {
  const values = new Map(parameters.map((parameter, position) => [position + 1, parameter.text]))
  return templateText.replace(/{{\s*(\d+)\s*}}/g, (match, index) => (
    values.get(Number(index)) || match
  ))
}

test('compacta el año del encabezado de cita cuando el texto materializado excede 60 caracteres', () => {
  const templateText = 'Cita programada para el {{1}}'
  const parameters = fitWhatsAppTemplateHeaderParameters({
    templateText,
    parameters: [{ type: 'text', text: 'miércoles, 26 de agosto de 2026 13:00' }]
  })

  assert.equal(parameters[0].text, 'miércoles, 26 de agosto 13:00')
  assert.equal(renderHeader(templateText, parameters), 'Cita programada para el miércoles, 26 de agosto 13:00')
  assert.ok(
    countWhatsAppTemplateCharacters(renderHeader(templateText, parameters)) <=
      WHATSAPP_TEMPLATE_TEXT_HEADER_MAX_LENGTH
  )
})

test('recorta cualquier otro valor largo sin perder la hora final', () => {
  const templateText = 'Cita programada para el {{1}}'
  const parameters = fitWhatsAppTemplateHeaderParameters({
    templateText,
    parameters: [{
      type: 'text',
      text: 'una descripción extraordinariamente extensa del miércoles 13:00'
    }]
  })
  const rendered = renderHeader(templateText, parameters)

  assert.equal(countWhatsAppTemplateCharacters(rendered), WHATSAPP_TEMPLATE_TEXT_HEADER_MAX_LENGTH)
  assert.match(parameters[0].text, /13:00$/)
  assert.match(parameters[0].text, /…/)
})

test('deja intactos los encabezados que ya caben', () => {
  const original = [{ type: 'text', text: 'viernes 21 de agosto 13:00' }]
  const fitted = fitWhatsAppTemplateHeaderParameters({
    templateText: 'Cita: {{1}}',
    parameters: original
  })

  assert.deepEqual(fitted, original)
})
