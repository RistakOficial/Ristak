import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import { createVariableField } from '../src/services/variableFieldsService.js'
import { renderTemplateVariables } from '../src/services/templateVariablesService.js'

test('renderTemplateVariables resuelve contacto, personalizados, variables y enlaces de disparo', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_variables_${suffix}`
  const phone = `+5255${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '7')}`
  let variableField
  let triggerLink

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        phone,
        `ana-${suffix}@example.test`,
        'Ana Prueba',
        'Ana',
        'Prueba',
        JSON.stringify([{ fieldKey: 'plan', label: 'Plan', value: 'Premium' }])
      ]
    )

    variableField = await createVariableField({
      label: 'Nombre del negocio',
      fieldKey: `negocio_${suffix.replace(/-/g, '_')}`,
      value: 'Ristak Demo'
    })

    triggerLink = await createTriggerLink(
      {
        name: `Promo ${suffix}`,
        destinationUrl: 'example.com/promo'
      },
      { baseUrl: 'https://app.ristak.test' }
    )

    const output = await renderTemplateVariables(
      `Hola {{first_name}}, plan {{custom.plan}}, negocio {{${variableField.parameter.slice(2, -2)}}}, link {{trigger_link.${triggerLink.publicId}}}, nada "{{no_existe}}"`,
      {
        contactId,
        publicBaseUrl: 'https://app.ristak.test'
      }
    )

    assert.match(output, /Hola Ana, plan Premium, negocio Ristak Demo/)
    assert.match(output, new RegExp(`https://app\\.ristak\\.test/trigger-links/${triggerLink.publicId}`))
    assert.match(output, new RegExp(`contact_id=${encodeURIComponent(contactId)}`))
    assert.match(output, /nada ""/)
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    if (variableField?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [variableField.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
