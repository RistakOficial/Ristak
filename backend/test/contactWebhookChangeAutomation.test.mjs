import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import { handleContactWebhook } from '../src/controllers/webhooksController.js'
import { serializeContactCustomFieldsForDb } from '../src/utils/contactCustomFields.js'

await databaseReady

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

async function waitForEnrollmentCount(automationId, contactId, expected, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    if (Number(row?.total || 0) === expected) return expected
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return Number((await db.get(
    'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
    [automationId, contactId]
  ))?.total || 0)
}

test('webhook de contacto publica el campo real cambiado y calla ante un reintento idéntico', async () => {
  const suffix = randomUUID()
  const contactId = `contact_webhook_change_${suffix}`
  const ghlContactId = `ghl_webhook_change_${suffix}`
  const automationId = `automation_webhook_change_${suffix}`
  const phone = `+523${Date.now().toString().slice(-10)}`
  const email = `webhook-change-${suffix}@test.com`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{
            id: 'country-change',
            type: 'trigger-contact-updated',
            config: {
              filters: [
                { field: 'changed_detail', match: 'is', value: 'custom:country' },
                { field: 'country', match: 'is', value: 'Colombia' }
              ]
            }
          }]
        }
      },
      { id: 'done', type: 'extra-comment', config: {} }
    ],
    edges: [{ id: 'start-done', sourceNodeId: 'start', targetNodeId: 'done' }],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }
  const webhookBody = {
    id: ghlContactId,
    phone,
    email,
    full_name: 'Contacto Webhook',
    first_name: 'Contacto',
    last_name: 'Webhook',
    source: 'gohighlevel',
    customFields: [{
      id: 'country',
      key: 'country',
      fieldKey: 'country',
      label: 'País',
      value: 'Colombia'
    }]
  }

  await db.run(
    `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, first_name, last_name, source, custom_fields)
     VALUES (?, ?, ?, ?, 'Contacto Webhook', 'Contacto', 'Webhook', 'gohighlevel', ?)`,
    [
      contactId,
      ghlContactId,
      phone,
      email,
      serializeContactCustomFieldsForDb([{
        id: 'country',
        key: 'country',
        fieldKey: 'country',
        label: 'País',
        value: 'México'
      }])
    ]
  )
  await db.run(
    `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
     VALUES (?, 'Cambio de país por webhook', 'published', ?, ?, CURRENT_TIMESTAMP)`,
    [automationId, JSON.stringify(flow), JSON.stringify(flow)]
  )

  try {
    const firstResponse = responseMock()
    await handleContactWebhook({ body: webhookBody }, firstResponse)
    assert.equal(firstResponse.statusCode, 200)
    assert.equal(await waitForEnrollmentCount(automationId, contactId, 1), 1)

    const repeatedResponse = responseMock()
    await handleContactWebhook({ body: webhookBody }, repeatedResponse)
    assert.equal(repeatedResponse.statusCode, 200)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await waitForEnrollmentCount(automationId, contactId, 1, 100), 1)

    const partialResponse = responseMock()
    await handleContactWebhook({
      body: {
        id: ghlContactId,
        phone,
        customFields: webhookBody.customFields
      }
    }, partialResponse)
    const preserved = await db.get('SELECT full_name, email FROM contacts WHERE id = ?', [contactId])
    assert.equal(preserved.full_name, 'Contacto Webhook')
    assert.equal(preserved.email, email)
    assert.equal(await waitForEnrollmentCount(automationId, contactId, 1, 100), 1)

    const partialNameResponse = responseMock()
    await handleContactWebhook({
      body: {
        id: ghlContactId,
        phone,
        firstName: 'Nuevo',
        customFields: webhookBody.customFields
      }
    }, partialNameResponse)
    const partiallyRenamed = await db.get(
      'SELECT full_name, first_name, last_name, email FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(partiallyRenamed.full_name, 'Nuevo Webhook')
    assert.equal(partiallyRenamed.first_name, 'Nuevo')
    assert.equal(partiallyRenamed.last_name, 'Webhook')
    assert.equal(partiallyRenamed.email, email)
    assert.equal(await waitForEnrollmentCount(automationId, contactId, 1, 100), 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
