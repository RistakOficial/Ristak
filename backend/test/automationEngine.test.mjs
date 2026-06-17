import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import {
  renderTemplate,
  filtersMatch,
  evaluateConditionNode,
  handleAutomationEvent,
  handleIncomingMessage,
  processScheduledTriggers,
  processScheduledContactEnrollments,
  enrollContactManually
} from '../src/services/automationEngine.js'

const ctx = {
  contact: {
    firstName: 'María',
    lastName: 'López',
    fullName: 'María López',
    phone: '+5215511223344',
    email: 'maria@test.com',
    source: 'Facebook',
    customFields: { ciudad: 'CDMX', tags: ['cliente'] },
    tags: ['cliente']
  },
  messageText: 'Hola, quiero el precio por favor',
  channel: 'whatsapp'
}

test('renderTemplate reemplaza variables del contacto y la conversación', () => {
  assert.equal(renderTemplate('Hola {{contact.first_name}}!', ctx), 'Hola María!')
  assert.equal(renderTemplate('Dijiste: {{conversation.last_message}}', ctx), 'Dijiste: Hola, quiero el precio por favor')
  assert.equal(renderTemplate('{{contact.custom.ciudad}}', ctx), 'CDMX')
  assert.equal(renderTemplate('{{desconocida.x}}', ctx), '')
})

test('renderTemplate resuelve payloads de webhook con objetos y arrays anidados', () => {
  const payload = {
    categories: [
      { name: 'Trabajo', items: ['Reunión', 'Email'] },
      { name: 'Salud', items: ['Agua', 'Ejercicio'] }
    ],
    mixed: ['texto', { deep: { value: 7 } }]
  }
  assert.equal(renderTemplate('{{webhook.categories[0].name}}', { payload }), 'Trabajo')
  assert.equal(renderTemplate('{{webhook.categories[1].items[1]}}', { payload }), 'Ejercicio')
  assert.equal(renderTemplate('{{webhook.mixed[1].deep.value}}', { payload }), '7')
})

test('renderTemplate expone datos del pago para acciones posteriores', () => {
  const paymentCtx = {
    paymentId: 'pay_123',
    amount: 1499,
    currency: 'MXN',
    paymentStatus: 'paid',
    product: 'Curso',
    provider: 'stripe',
    paymentMethod: 'card',
    reference: 'Invoice #INV-55',
    invoiceNumber: 'INV-55',
    paymentDate: '2026-06-14T10:00:00.000Z'
  }
  assert.equal(renderTemplate('{{pago_1.monto}} {{pago_1.moneda}}', paymentCtx), '1499 MXN')
  assert.equal(renderTemplate('{{payment.product}}', paymentCtx), 'Curso')
  assert.equal(renderTemplate('{{payment.invoice_number}}', paymentCtx), 'INV-55')
})

test('filtersMatch: coincide / NO coincide / contiene / NO contiene', () => {
  assert.equal(filtersMatch([{ field: 'source', match: 'is', value: 'facebook' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'source', match: 'not', value: 'Facebook' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'message', match: 'contains', value: 'PRECIO' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'message', match: 'not_contains', value: 'precio' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'custom', customKey: 'ciudad', match: 'is', value: 'cdmx' }], ctx), true)
  // Un filtro incompleto (sin campo) se ignora: por sí solo no bloquea
  assert.equal(filtersMatch([{ field: '', match: 'is', value: 'x' }], ctx), true)
  // Un campo del evento sin dato en este contexto (p. ej. calendario en un
  // mensaje) no bloquea: se trata como desconocido
  assert.equal(filtersMatch([{ field: 'calendar', match: 'is', value: 'x' }], ctx), true)
  // Un campo de contacto reconocido cuyo valor no coincide sí bloquea
  assert.equal(filtersMatch([{ field: 'stage', match: 'is', value: 'x' }], ctx), false)
})

test('filtersMatch: filtra datos completos del evento de pago', () => {
  const paymentCtx = {
    paymentId: 'pay_123',
    amount: 1499,
    currency: 'MXN',
    paymentStatus: 'refunded',
    product: 'Curso',
    provider: 'stripe',
    paymentMethod: 'card',
    reference: 'Invoice #INV-55',
    invoiceNumber: 'INV-55'
  }
  assert.equal(filtersMatch([{ field: 'payment_status', match: 'is', value: 'refunded' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'amount', match: 'is', value: '1499' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_method', match: 'contains', value: 'card' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'receipt', match: 'contains', value: 'INV-55' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'provider', match: 'is', value: 'paypal' }], paymentCtx), false)
})

test('filtersMatch: formulario enviado puede ser descalificado o no descalificado', () => {
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'is_disqualified', value: '' }], {
    formStatus: 'disqualified'
  }), true)
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'not_disqualified', value: '' }], {
    formStatus: 'received'
  }), true)
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'is_disqualified', value: '' }], {
    formStatus: 'received'
  }), false)
})

test('formularios exponen respuestas no guardadas para variables, filtros y condiciones', () => {
  const formCtx = {
    contact: {
      fullName: 'Lead Formulario',
      phone: '+5215555555555',
      email: 'lead-form@test.com'
    },
    formId: 'site_form_123',
    formName: 'Diagnóstico',
    submissionId: 'submission_123',
    formStatus: 'disqualified',
    formDisqualified: true,
    submittedAt: '2026-06-17T20:00:00.000Z',
    formResponses: {
      answers: [
        { id: 'field_budget', key: 'presupuesto', label: 'Presupuesto mensual', value: '5000', type: 'currency' },
        { id: 'field_need', key: 'necesidad', label: 'Necesidad', value: 'Seguimiento por WhatsApp', type: 'text' }
      ]
    }
  }

  assert.equal(renderTemplate('{{form.answers}}', formCtx), 'Presupuesto mensual: 5000\nNecesidad: Seguimiento por WhatsApp')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto}}', formCtx), '5000')
  assert.equal(renderTemplate('{{formulario.respuestas_por_id.field_budget}}', formCtx), '5000')
  assert.equal(filtersMatch([{ field: 'form-field-value', customKey: 'presupuesto', match: 'is', value: '5000' }], formCtx), true)
  assert.equal(filtersMatch([{ field: 'form-field-value', match: 'contains', value: 'WhatsApp' }], formCtx), true)

  const condition = {
    branches: [
      {
        name: 'Presupuesto suficiente',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [{
            field: 'var:formulario.respuestas.presupuesto',
            operator: 'gte',
            value: '4000'
          }]
        }]
      }
    ]
  }
  assert.equal(evaluateConditionNode(condition, formCtx).handle, 'yes')
})

test('evaluateConditionNode: una rama → Sí/No', () => {
  const config = {
    branches: [
      {
        name: 'Interesado',
        groupsOperator: 'AND',
        groups: [{ operator: 'AND', negate: false, rules: [{ field: 'conv-keyword', operator: 'contains', value: 'precio' }] }]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { ...ctx, messageText: 'gracias' }).handle, 'no')
})

test('evaluateConditionNode: usa la respuesta recibida de un evento anterior', () => {
  const config = {
    branches: [
      {
        name: 'Respuesta con precio',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [{
            field: 'var:respuesta_whatsapp.cuerpo',
            fieldLabel: 'Respuesta del contacto · Cuerpo',
            fieldType: 'text',
            operator: 'contains',
            value: 'precio'
          }]
        }]
      }
    ]
  }

  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { ...ctx, messageText: 'Solo quiero saludar' }).handle, 'no')
})

test('evaluateConditionNode: usa la salida de un webhook/post anterior', () => {
  const config = {
    branches: [
      {
        name: 'Webhook exitoso',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [
            {
              field: 'var:http_request_1.status_code',
              fieldLabel: 'HTTP Request #1 · Código de estado',
              fieldType: 'number',
              fieldSourceId: 'node-webhook',
              fieldPath: 'status_code',
              operator: 'gte',
              value: '200'
            },
            {
              field: 'var:http_request_1.respuesta.lead_id',
              fieldLabel: 'HTTP Request #1 · Respuesta > Lead ID',
              fieldType: 'text',
              fieldSourceId: 'node-webhook',
              fieldPath: 'respuesta.lead_id',
              operator: 'not_empty',
              value: ''
            }
          ]
        }]
      }
    ]
  }
  const webhookCtx = {
    __nodeOutputs: {
      'node-webhook': {
        status: 'ok',
        status_code: 201,
        respuesta: { lead_id: 'lead_123' }
      }
    }
  }

  assert.equal(evaluateConditionNode(config, webhookCtx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { __nodeOutputs: { 'node-webhook': { status_code: 500, respuesta: {} } } }).handle, 'no')
})

test('evaluateConditionNode: multi-rama elige la primera que cumple, si no "none"', () => {
  const config = {
    branches: [
      { id: 'b1', name: 'Por email', groups: [{ operator: 'AND', rules: [{ field: 'contact-email', operator: 'contains', value: '@otro.com' }] }] },
      { id: 'b2', name: 'Facebook', groups: [{ operator: 'AND', rules: [{ field: 'contact-source', operator: 'is', value: 'facebook' }] }] }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'b2')
  const none = evaluateConditionNode(config, { ...ctx, contact: { ...ctx.contact, source: 'Google', email: 'a@b.c' } })
  assert.equal(none.handle, 'none')
})

test('evaluateConditionNode: grupo negado y operador OR', () => {
  const config = {
    branches: [
      {
        name: 'Regla',
        groupsOperator: 'AND',
        groups: [
          { operator: 'OR', negate: false, rules: [
            { field: 'contact-first-name', operator: 'is', value: 'Pedro' },
            { field: 'contact-first-name', operator: 'is', value: 'María' }
          ] },
          { operator: 'AND', negate: true, rules: [{ field: 'contact-source', operator: 'is', value: 'Google' }] }
        ]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
})

test('filtersMatch: conector O entre filtros', () => {
  const filters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'or' }
  ]
  assert.equal(filtersMatch(filters, ctx), true) // fuente falla pero mensaje sí (O)
  const andFilters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'and' }
  ]
  assert.equal(filtersMatch(andFilters, ctx), false)
})

test('logic-wait por duración respeta segundos', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_wait_seconds_${suffix}`
  const automationId = `automation_wait_seconds_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-seconds',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'duration',
          amount: 10,
          unit: 'seconds'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-seconds' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-seconds', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `wait-seconds-${suffix}@example.com`,
        'Contacto Segundos',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test espera segundos', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const before = Date.now()
    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })
    const after = Date.now()

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    const resumeAt = new Date(enrollment.resume_at).getTime()
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'duration')
    assert.equal(enrollment.current_node_id, 'wait-seconds')
    assert.ok(resumeAt >= before + 10_000)
    assert.ok(resumeAt <= after + 11_000)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('logic-wait por clic de disparo reanuda cuando llega el trigger link configurado', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_trigger_wait_${suffix}`
  const automationId = `automation_trigger_wait_${suffix}`
  const matchingTriggerLinkId = `trigger_link_${suffix}`
  const otherTriggerLinkId = `trigger_link_other_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-click',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'action',
          expectedAction: 'click_link',
          actionResource: matchingTriggerLinkId,
          actionResourceName: 'Promo demo'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-click' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-click', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `trigger-${suffix}@example.com`,
        'Contacto Trigger',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test clic de disparo', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'trigger-link-click')
    assert.equal(enrollment.current_node_id, 'wait-click')
    assert.equal(JSON.parse(enrollment.context).waitActionResource, matchingTriggerLinkId)

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId: otherTriggerLinkId,
      triggerLinkPublicId: 'otro-publico',
      triggerLinkName: 'Otro link'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId: matchingTriggerLinkId,
      triggerLinkPublicId: 'promo-publica',
      triggerLinkName: 'Promo demo'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Clic de disparo recibido')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('logic-wait por respuesta a mensaje queda esperando y reanuda con el siguiente mensaje', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_reply_wait_${suffix}`
  const automationId = `automation_reply_wait_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-reply',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'action',
          expectedAction: 'reply_message',
          actionResource: 'msg-whatsapp-1',
          actionResourceName: 'WhatsApp de bienvenida'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-reply' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-reply', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1666${Date.now().toString().slice(-8)}`,
        `reply-${suffix}@example.com`,
        'Contacto Reply',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test respuesta a mensaje', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'reply')
    assert.equal(enrollment.current_node_id, 'wait-reply')
    assert.equal(JSON.parse(enrollment.context).waitActionResource, 'msg-whatsapp-1')

    await handleIncomingMessage({
      contactId,
      text: 'sí me interesa',
      channel: 'whatsapp'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('respondió a "WhatsApp de bienvenida"')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger Pagos distingue acción del pago y filtros del recibo', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_payment_trigger_${suffix}`
  const automationId = `automation_payment_trigger_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-payment',
              type: 'trigger-payment-received',
              config: {
                paymentAction: 'refunded',
                filters: [{ field: 'provider', match: 'is', value: 'stripe' }]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `payment-trigger-${suffix}@example.com`,
        'Contacto Pago',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test pagos refund', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentStatus: 'failed',
      provider: 'stripe',
      amount: 1200,
      currency: 'MXN'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Boolean(enrollment), false)

    await handleAutomationEvent('refund', {
      contactId,
      paymentStatus: 'refunded',
      provider: 'paypal',
      amount: 1200,
      currency: 'MXN'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Boolean(enrollment), false)

    await handleAutomationEvent('refund', {
      contactId,
      paymentId: `pay_${suffix}`,
      paymentStatus: 'refunded',
      provider: 'stripe',
      paymentMethod: 'card',
      product: 'Curso',
      amount: 1200,
      currency: 'MXN',
      invoiceNumber: `INV-${suffix.slice(0, 6)}`
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('webhook encuentra contacto por valor mapeado y asigna usuario', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_webhook_find_${suffix}`
  const automationId = `automation_webhook_find_${suffix}`
  const endpointId = `hook_${suffix}`
  const email = `webhook-find-${suffix}@example.com`
  const assignedUser = `user_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-webhook',
              type: 'trigger-incoming-webhook',
              config: { endpointId }
            }
          ]
        }
      },
      {
        id: 'find-contact',
        type: 'action-find-contact',
        label: 'Encontrar contacto',
        config: {
          searchBy: 'email',
          lookupValue: '{{webhook.contacts[0].email}}',
          notFound: 'stop'
        }
      },
      {
        id: 'assign-user',
        type: 'action-contact-user',
        label: 'Añadir / eliminar usuario asignado',
        config: {
          userAction: 'assign',
          user: assignedUser,
          userName: 'Ventas'
        }
      }
    ],
    edges: [
      { id: 'edge-start-find', sourceNodeId: 'start', targetNodeId: 'find-contact' },
      { id: 'edge-find-assign', sourceNodeId: 'find-contact', sourceHandle: 'out', targetNodeId: 'assign-user' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        email,
        'Contacto Webhook',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test webhook find', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('webhook-received', {
      endpointId,
      payload: {
        contacts: [
          {
            email,
            categories: [
              { name: 'Trabajo', items: ['Reunión', 'Email'] }
            ]
          }
        ]
      }
    })

    const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = JSON.parse(contact.custom_fields)
    assert.equal(customFields.assignedUser, assignedUser)
    assert.equal(customFields.assignedUserName, 'Ventas')

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.contact_id, contactId)
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Contacto encontrado')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger fecha programada inscribe una sola vez por horario', async () => {
  const suffix = randomUUID()
  const automationId = `automation_schedule_trigger_${suffix}`
  const now = DateTime.now().setZone('America/Mexico_City').startOf('minute')
  const scheduledAt = now.toFormat("yyyy-LL-dd'T'HH:mm")
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: `trigger-schedule-${suffix}`,
              type: 'trigger-scheduler',
              config: {
                scheduleMode: 'once',
                datetime: scheduledAt,
                recurrence: 'none',
                weekdays: []
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { timezone: 'America/Mexico_City' }
  }

  try {
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test fecha programada', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await processScheduledTriggers(now.plus({ seconds: 30 }).toUTC().toJSDate())
    await processScheduledTriggers(now.plus({ seconds: 40 }).toUTC().toJSDate())

    const enrollments = await db.all('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollments.length, 1)
    assert.equal(enrollments[0].status, 'completed')
    assert.equal(enrollments[0].current_node_id, 'done')

    const runs = await db.all('SELECT * FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    assert.equal(runs.length, 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
  }
})

test('acción cambia el número de WhatsApp preferido del contacto', async () => {
  const suffix = randomUUID()
  const automationId = `automation_whatsapp_number_action_${suffix}`
  const contactId = `contact_whatsapp_number_action_${suffix}`
  const oldPhoneId = `wa_old_${suffix}`
  const newPhoneId = `wa_new_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
          ]
        }
      },
      {
        id: 'change-number',
        type: 'action-change-whatsapp-number',
        label: 'Cambiar número de WhatsApp',
        config: {
          phoneNumberId: newPhoneId,
          phoneNumberIdName: 'Soporte',
          reason: 'Asignado desde {{automation.name}}'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-change', sourceNodeId: 'start', targetNodeId: 'change-number' },
      { id: 'edge-change-done', sourceNodeId: 'change-number', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, preferred_whatsapp_phone_number_id, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `wa-action-${suffix}@test.com`, 'Contacto WhatsApp', 'Contacto', oldPhoneId, '{}']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [oldPhoneId, '525511111111', '+52 55 1111 1111', 'Ventas Meta', 'Ventas']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [newPhoneId, '525522222222', '+52 55 2222 2222', 'Soporte Meta', 'Soporte']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test cambio número WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    const updated = await db.get('SELECT preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(updated.preferred_whatsapp_phone_number_id, newPhoneId)
    const routingEvent = await db.get('SELECT * FROM whatsapp_routing_events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1', [contactId])
    assert.equal(routingEvent.previous_phone_number_id, oldPhoneId)
    assert.equal(routingEvent.new_phone_number_id, newPhoneId)
    assert.equal(routingEvent.reason, 'Asignado desde Test cambio número WhatsApp')
    assert.equal(routingEvent.source, 'automation')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Número de WhatsApp cambiado a Soporte')), true)
  } finally {
    await db.run('DELETE FROM whatsapp_routing_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [oldPhoneId, newPhoneId])
  }
})

test('trigger contacto modificado filtra número de WhatsApp asignado', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_whatsapp_${suffix}`
  const contactId = `contact_change_whatsapp_${suffix}`
  const phoneId = `wa_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'preferredWhatsAppPhoneNumberId',
                    valueLabel: 'Número de WhatsApp asignado'
                  },
                  {
                    field: 'preferred_whatsapp_number',
                    match: 'is',
                    value: phoneId,
                    valueLabel: 'Soporte'
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, preferred_whatsapp_phone_number_id, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `wa-change-${suffix}@test.com`, 'Contacto Cambio WhatsApp', 'Contacto', phoneId, '{}']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [phoneId, '525533333333', '+52 55 3333 3333', 'Soporte Meta', 'Soporte']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: ['preferredWhatsAppPhoneNumberId']
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => {
      const detail = String(entry.detail || '')
      return detail.includes('cambió') && detail.includes('preferredWhatsAppPhoneNumberId')
    }), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('trigger contacto modificado filtra totales de pago del contacto', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_payment_${suffix}`
  const contactId = `contact_change_payment_${suffix}`
  const paymentId = `payment_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'totalPaid',
                    valueLabel: 'Total pagado'
                  },
                  {
                    field: 'total_paid',
                    match: 'gte',
                    value: '100'
                  },
                  {
                    field: 'payments_count',
                    match: 'gte',
                    value: '1'
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `payment-change-${suffix}@test.com`, 'Contacto Cambio Pago', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, payment_mode, reference, title, date)
       VALUES (?, ?, ?, 'MXN', 'paid', 'card', 'live', ?, ?, ?)`,
      [paymentId, contactId, 150, `INV-${suffix}`, 'Compra prueba', '2026-06-16T12:00:00.000Z']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado pagos', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentId,
      amount: 150,
      paymentStatus: 'paid',
      product: 'Compra prueba'
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('pago exitoso')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger contacto modificado filtra cita activa y cantidad de citas', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_appointment_${suffix}`
  const contactId = `contact_change_appointment_${suffix}`
  const appointmentId = `appointment_contact_change_${suffix}`
  const calendarId = `calendar_contact_change_${suffix}`
  const assignedUserId = `user_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'activeAppointment',
                    valueLabel: 'Cita activa'
                  },
                  {
                    field: 'has_active_appointment',
                    match: 'yes',
                    value: ''
                  },
                  {
                    field: 'appointments_count',
                    match: 'gte',
                    value: '1'
                  },
                  {
                    field: 'active_appointment_status',
                    match: 'is',
                    value: 'confirmed'
                  },
                  {
                    field: 'active_appointment_calendar',
                    match: 'is',
                    value: calendarId
                  },
                  {
                    field: 'active_appointment_assigned',
                    match: 'is',
                    value: assignedUserId
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `appointment-change-${suffix}@test.com`, 'Contacto Cambio Cita', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO appointments (id, calendar_id, contact_id, title, status, appointment_status, assigned_user_id, start_time, end_time)
       VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?, ?)`,
      [
        appointmentId,
        calendarId,
        contactId,
        'Cita prueba',
        assignedUserId,
        '2026-06-18T16:00:00.000Z',
        '2026-06-18T17:00:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado citas', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed'
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('agendó una cita')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('inscripción manual mete un contacto publicado al flujo seleccionado', async () => {
  const suffix = randomUUID()
  const automationId = `automation_manual_${suffix}`
  const contactId = `contact_manual_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, `manual-${suffix}@test.com`, 'Contacto Manual', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test manual', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const result = await enrollContactManually({ automationId, contactId })

    assert.equal(result.automationId, automationId)
    assert.equal(result.contactId, contactId)
    assert.equal(result.status, 'completed')
    assert.equal(result.currentNodeId, 'done')

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [result.id])
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Agregado manualmente')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_contact_enrollment_jobs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('inscripción manual programada se ejecuta cuando llega su fecha', async () => {
  const suffix = randomUUID()
  const automationId = `automation_manual_scheduled_${suffix}`
  const contactId = `contact_manual_scheduled_${suffix}`
  const jobId = `autojob_${suffix}`
  const scheduledAt = new Date(Date.now() - 1000).toISOString()
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+522${Date.now().toString().slice(-10)}`, `manual-scheduled-${suffix}@test.com`, 'Contacto Programado', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test manual programada', JSON.stringify(flow), JSON.stringify(flow)]
    )
    await db.run(
      `INSERT INTO automation_contact_enrollment_jobs
         (id, automation_id, contact_id, contact_name, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, 'scheduled')`,
      [jobId, automationId, contactId, 'Contacto Programado', scheduledAt]
    )

    await processScheduledContactEnrollments(new Date())

    const job = await db.get('SELECT * FROM automation_contact_enrollment_jobs WHERE id = ?', [jobId])
    assert.equal(job.status, 'completed')
    assert.ok(job.enrollment_id)

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [job.enrollment_id])
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.contact_id, contactId)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_contact_enrollment_jobs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})
