import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWhatsAppMessagePresentation } from '../src/services/chatMessagePresentationService.js'

test('reconstruye una plantilla con botón URL sin exponer ni activar el enlace rastreado', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'template',
    messageText: 'Aquí está el enlace.\n\n- Google Meet',
    templateSendRawPayload: {
      request: {
        template: {
          name: 'enlace_videollamada_google_meet_seguro',
          language: { code: 'es_MX' },
          components: [{
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'pce1_secreto_rastreado' }]
          }]
        }
      },
      template: {
        components: [
          { type: 'BODY', text: 'Aquí está el enlace.' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Google Meet', url: 'https://example.test/{{1}}' }] }
        ]
      }
    }
  })

  assert.deepEqual(presentation, {
    kind: 'template',
    body: 'Aquí está el enlace.',
    buttons: [{ type: 'url', label: 'Google Meet' }]
  })
  assert.doesNotMatch(JSON.stringify(presentation), /pce1_|example\.test/)
})

test('renderiza encabezado, variables, pie y respuestas rápidas de la plantilla', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'template',
    templateSendRawPayload: {
      request: {
        template: {
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: 'Jesús' },
              { type: 'text', text: 'martes 4 de agosto' }
            ]
          }]
        }
      },
      template: {
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'Confirma tu cita' },
          { type: 'BODY', text: 'Hola {{1}}, tu cita es el {{2}}.' },
          { type: 'FOOTER', text: 'Mensaje automático' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Sí, confirmar' },
              { type: 'QUICK_REPLY', text: 'Necesito cambiarla' }
            ]
          }
        ]
      }
    }
  })

  assert.deepEqual(presentation, {
    kind: 'template',
    header: { kind: 'text', text: 'Confirma tu cita' },
    body: 'Hola Jesús, tu cita es el martes 4 de agosto.',
    footer: 'Mensaje automático',
    buttons: [
      { type: 'quick_reply', label: 'Sí, confirmar' },
      { type: 'quick_reply', label: 'Necesito cambiarla' }
    ]
  })
})

test('normaliza mensajes interactivos con botones sin convertirlos en controles ejecutables', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'interactive',
    messageRawPayload: {
      interactive: {
        header: { type: 'text', text: 'Elige una opción' },
        body: { text: '¿Cómo deseas continuar?' },
        footer: { text: 'Puedes responder en WhatsApp' },
        action: {
          buttons: [
            { type: 'reply', reply: { title: 'Agendar ahora' } },
            { type: 'url', title: 'Ver información' }
          ]
        }
      }
    }
  })

  assert.deepEqual(presentation, {
    kind: 'interactive',
    header: { kind: 'text', text: 'Elige una opción' },
    body: '¿Cómo deseas continuar?',
    footer: 'Puedes responder en WhatsApp',
    buttons: [
      { type: 'quick_reply', label: 'Agendar ahora' },
      { type: 'url', label: 'Ver información' }
    ]
  })
})

test('lee botones de flujo nativo y conserva solo su etiqueta visible', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'interactive',
    messageRawPayload: {
      interactive: {
        header: {
          type: 'image',
          image: { link: 'https://cdn.example.test/header.jpg' }
        },
        body: { text: 'Consulta los detalles.' },
        nativeFlowMessage: {
          buttons: [{
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: 'Abrir información',
              url: 'https://example.test/accion-privada'
            })
          }]
        }
      }
    }
  })

  assert.deepEqual(presentation, {
    kind: 'interactive',
    header: {
      kind: 'image',
      mediaUrl: 'https://cdn.example.test/header.jpg'
    },
    body: 'Consulta los detalles.',
    buttons: [{ type: 'url', label: 'Abrir información' }]
  })
  assert.doesNotMatch(JSON.stringify(presentation), /accion-privada/)
})

test('presenta contactos Cloud API con nombre estructurado, teléfonos y correo', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'contacts',
    messageRawPayload: {
      type: 'contacts',
      contacts: [{
        name: { formatted_name: 'Carlos Mendoza', first_name: 'Carlos', last_name: 'Mendoza' },
        phones: [{ phone: '+52 443 147 5304', wa_id: '524431475304' }],
        emails: [{ email: 'carlos@example.com' }]
      }]
    }
  })

  assert.deepEqual(presentation, {
    kind: 'contacts',
    header: { kind: 'text', text: 'Contacto compartido' },
    body: '',
    buttons: [],
    sections: [{
      title: 'Carlos Mendoza',
      items: [
        { kind: 'phone', label: '+52 443 147 5304' },
        { kind: 'email', label: 'carlos@example.com' }
      ]
    }]
  })
  assert.doesNotMatch(JSON.stringify(presentation), /\[object Object\]/)
})

test('presenta pedidos con la moneda explícita del proveedor', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'order',
    messageRawPayload: {
      order: {
        text: 'Quiero estos productos',
        currency: 'USD',
        product_items: [{ product_retailer_id: 'SKU-42', quantity: 2, item_price: 19.5 }]
      }
    }
  })

  assert.equal(presentation.kind, 'order')
  assert.equal(presentation.body, 'Quiero estos productos')
  assert.equal(presentation.sections[0].items[0].kind, 'product')
  assert.equal(presentation.sections[0].items[0].label, 'SKU-42')
  assert.match(presentation.sections[0].items[0].value, /^2 piezas · USD\s*19\.50$/)
})

test('no inventa moneda para importes externos incompletos', () => {
  const presentation = buildWhatsAppMessagePresentation({
    messageType: 'order',
    messageRawPayload: {
      order: {
        product_items: [{ product_retailer_id: 'SKU-SIN-MONEDA', quantity: 1, item_price: 250 }]
      }
    }
  })

  assert.deepEqual(presentation.sections[0].items[0], {
    kind: 'product',
    label: 'SKU-SIN-MONEDA'
  })
  assert.doesNotMatch(JSON.stringify(presentation), /MXN|USD|250/)
})

test('presenta respuestas de listas y formularios sin filtrar tokens internos', () => {
  const listReply = buildWhatsAppMessagePresentation({
    messageType: 'interactive',
    messageRawPayload: {
      interactive: { list_reply: { id: 'internal-row-id', title: 'Sucursal Centro', description: 'Abierto hoy' } }
    }
  })
  assert.equal(listReply.kind, 'interactive_reply')
  assert.equal(listReply.body, 'Sucursal Centro')
  assert.doesNotMatch(JSON.stringify(listReply), /internal-row-id/)

  const flowReply = buildWhatsAppMessagePresentation({
    messageType: 'interactive_reply',
    messageRawPayload: {
      interactive: {
        nfm_reply: {
          body: 'Formulario completado',
          response_json: JSON.stringify({ nombre: 'Ana', preferencias: { horario: 'Tarde' }, flow_token: 'secreto' })
        }
      }
    }
  })
  assert.equal(flowReply.kind, 'interactive_reply')
  assert.deepEqual(flowReply.sections[0].items, [
    { kind: 'info', label: 'Nombre', value: 'Ana' },
    { kind: 'info', label: 'Preferencias · Horario', value: 'Tarde' }
  ])
  assert.doesNotMatch(JSON.stringify(flowReply), /secreto|flow_token/)
})

test('presenta contactos y encuestas capturados desde WhatsApp QR', () => {
  const contact = buildWhatsAppMessagePresentation({
    messageType: 'contacts',
    messageRawPayload: {
      qrRaw: {
        message: {
          contactMessage: {
            displayName: 'María López',
            vcard: 'BEGIN:VCARD\nFN:María López\nTEL;TYPE=CELL:+52 656 555 0101\nEND:VCARD'
          }
        }
      }
    }
  })
  assert.equal(contact.sections[0].title, 'María López')
  assert.equal(contact.sections[0].items[0].label, '+52 656 555 0101')

  const poll = buildWhatsAppMessagePresentation({
    messageType: 'poll',
    messageRawPayload: {
      qrRaw: {
        message: {
          pollCreationMessageV3: {
            name: '¿Qué horario prefieres?',
            options: [{ optionName: 'Mañana' }, { optionName: 'Tarde' }]
          }
        }
      }
    }
  })
  assert.equal(poll.kind, 'poll')
  assert.equal(poll.body, '¿Qué horario prefieres?')
  assert.deepEqual(poll.sections[0].items.map(item => item.label), ['Mañana', 'Tarde'])
})
