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
