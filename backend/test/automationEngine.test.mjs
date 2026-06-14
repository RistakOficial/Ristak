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
