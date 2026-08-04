import assert from 'node:assert/strict'
import test from 'node:test'

import { getWhatsAppTemplateVariableLabel } from '../src/utils/whatsappTemplateVariableLabels.ts'

const bindings = {
  headerText: {
    1: {
      label: 'Nombre del negocio',
      variableKey: 'account.company_name',
      mergeField: '{{account.company_name}}'
    }
  },
  bodyText: {
    1: {
      label: 'Nombre del contacto',
      variableKey: 'contact.first_name',
      mergeField: '{{contact.first_name}}'
    },
    2: {
      variableKey: 'contact.phone',
      mergeField: '{{contact.phone}}'
    },
    3: {
      mergeField: '{{cita.fecha}}'
    }
  }
}

test('usa el nombre configurado para la sección correcta de la plantilla', () => {
  assert.equal(getWhatsAppTemplateVariableLabel(bindings, 'headerText', '1'), 'Nombre del negocio')
  assert.equal(getWhatsAppTemplateVariableLabel(bindings, 'bodyText', '1'), 'Nombre del contacto')
})

test('mantiene fallbacks informativos para configuraciones antiguas o incompletas', () => {
  assert.equal(getWhatsAppTemplateVariableLabel(bindings, 'bodyText', '2'), 'contact.phone')
  assert.equal(getWhatsAppTemplateVariableLabel(bindings, 'bodyText', '3'), 'cita.fecha')
  assert.equal(getWhatsAppTemplateVariableLabel(bindings, 'bodyText', '4'), 'Variable 4')
})
