import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSupplementalWhatsAppMessageText,
  isWhatsAppProviderContentUnavailable,
  shouldTriggerWhatsAppInboundSideEffects
} from '../src/services/whatsappMessageContentService.js'

test('normaliza contactos compartidos con nombre y teléfonos', () => {
  assert.equal(
    extractSupplementalWhatsAppMessageText({
      type: 'contacts',
      contacts: [
        {
          profile: { formatted_name: 'Ana Torres' },
          phones: [{ phone: '+52 656 123 4567' }, { wa_id: '526561234567' }]
        }
      ]
    }),
    'Contacto compartido: Ana Torres · +52 656 123 4567'
  )

  assert.equal(
    extractSupplementalWhatsAppMessageText({
      type: 'contacts',
      contacts: [{
        name: { formatted_name: 'Carlos Mendoza', first_name: 'Carlos' },
        phones: [{ phone: '+52 443 147 5304' }]
      }]
    }),
    'Contacto compartido: Carlos Mendoza · +52 443 147 5304'
  )
  assert.doesNotMatch(
    extractSupplementalWhatsAppMessageText({
      type: 'contacts',
      contacts: [{ name: { formatted_name: 'Carlos Mendoza' } }]
    }),
    /\[object Object\]/
  )
})

test('lee contactos QR en vCard sin imprimir objetos internos', () => {
  assert.equal(
    extractSupplementalWhatsAppMessageText({
      contacts: [{
        vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:María López\nTEL;TYPE=CELL:+52 656 555 0101\nEND:VCARD'
      }]
    }, { messageType: 'contacts' }),
    'Contacto compartido: María López · +52 656 555 0101'
  )
})

test('ignora el destinatario técnico del ACK de un envío de texto de Meta', () => {
  assert.equal(
    extractSupplementalWhatsAppMessageText({
      type: 'text',
      text: { body: 'Buenas noches, que descanses' },
      contacts: [{ input: '+524436816403', wa_id: '5214436816403' }],
      messages: [{ id: 'wamid.ack-tecnico' }]
    }),
    ''
  )
})

test('normaliza pedidos, avisos del sistema y el contenido anidado de una edición', () => {
  assert.equal(
    extractSupplementalWhatsAppMessageText({
      type: 'order',
      order: {
        text: 'Estos son los productos',
        product_items: [{ quantity: 2 }, { quantity: 1 }]
      }
    }),
    'Estos son los productos\nPedido compartido · 3 productos'
  )
  assert.equal(
    extractSupplementalWhatsAppMessageText({ type: 'system', system: { body: 'El cliente cambió de número.' } }),
    'El cliente cambió de número.'
  )
  assert.equal(
    extractSupplementalWhatsAppMessageText({
      type: 'edit',
      edit: { message: { type: 'text', text: { body: 'Texto corregido' } } }
    }),
    'Texto corregido'
  )
})

test('distingue contenido que el proveedor no entrega de un fallo de envío', () => {
  assert.equal(isWhatsAppProviderContentUnavailable({ messageType: 'unsupported', errorCode: '131051' }), true)
  assert.equal(isWhatsAppProviderContentUnavailable({ messageType: 'unsupported', errorCode: '131060' }), true)
  assert.equal(isWhatsAppProviderContentUnavailable({ messageType: 'image', errorMessage: '' }), false)
  assert.equal(shouldTriggerWhatsAppInboundSideEffects({ messageType: 'unsupported', contentUnavailable: true }), false)
  assert.equal(shouldTriggerWhatsAppInboundSideEffects({ messageType: 'edit', contentUnavailable: false }), false)
  assert.equal(shouldTriggerWhatsAppInboundSideEffects({ messageType: 'contacts', contentUnavailable: false }), true)
})
