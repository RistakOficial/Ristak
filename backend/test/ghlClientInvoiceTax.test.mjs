import test from 'node:test'
import assert from 'node:assert/strict'

import { translateRistakTaxToHighLevelItems } from '../src/utils/highLevelInvoiceTax.js'

test('la traducción fiscal suma el impuesto al total remoto de HighLevel', () => {
  const invoice = {
    name: 'Prueba fiscal',
    title: 'Prueba fiscal',
    currency: 'MXN',
    contactDetails: { id: 'contact-test', name: 'Raúl Gómez' },
    items: [{
      name: 'Servicio',
      description: 'Servicio de prueba',
      amount: 100,
      qty: 1,
      currency: 'MXN'
    }],
    tax: {
      name: 'IVA',
      rate: 16,
      amount: 16,
      calculationMode: 'exclusive'
    },
    liveMode: false
  }
  const requestBody = translateRistakTaxToHighLevelItems(invoice)

  assert.equal(requestBody.tax, undefined, 'HighLevel no debe recibir el campo fiscal interno')
  assert.equal(invoice.items.length, 1, 'la traducción no debe mutar el payload fiscal original')
  assert.deepEqual(requestBody.items, [
    {
      name: 'Servicio',
      description: 'Servicio de prueba',
      amount: 100,
      qty: 1,
      currency: 'MXN'
    },
    {
      name: 'IVA',
      description: 'IVA 16%',
      amount: 16,
      qty: 1,
      currency: 'MXN'
    }
  ])
  assert.equal(
    requestBody.items.reduce((total, item) => total + item.amount * item.qty, 0),
    116,
    'el total remoto debe coincidir con el importe que se registrará como pagado'
  )
})

test('la traducción fiscal no inventa una línea cuando el impuesto es cero', () => {
  const requestBody = translateRistakTaxToHighLevelItems({
    name: 'Operación exenta',
    currency: 'MXN',
    items: [{ name: 'Servicio exento', amount: 100, qty: 1, currency: 'MXN' }],
    tax: { name: 'IVA', rate: 0, amount: 0 },
    liveMode: false
  })

  assert.equal(requestBody.tax, undefined)
  assert.deepEqual(requestBody.items, [
    { name: 'Servicio exento', amount: 100, qty: 1, currency: 'MXN' }
  ])
})
