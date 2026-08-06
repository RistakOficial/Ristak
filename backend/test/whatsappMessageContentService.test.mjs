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
    'Contacto compartido: Ana Torres · +52 656 123 4567, 526561234567'
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
