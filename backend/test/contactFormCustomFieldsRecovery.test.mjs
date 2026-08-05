import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import {
  prepareContactCustomFieldsForStorage
} from '../src/services/contactCustomFieldDefinitionsService.js'
import {
  runContactFormCustomFieldsRecovery
} from '../src/services/contactFormCustomFieldsRecoveryService.js'
import { createSite, deleteSite } from '../src/services/sitesService.js'
import { parseContactCustomFields, serializeContactCustomFieldsForDb } from '../src/utils/contactCustomFields.js'

await databaseReady

test('recupera del historial todos los tipos de campo sin reemplazar datos actuales', async () => {
  const suffix = crypto.randomUUID().replaceAll('-', '_')
  const contactId = `contact_recovery_${suffix}`
  const keys = {
    text: `texto_${suffix}`,
    radio: `radio_${suffix}`,
    checkboxes: `checks_${suffix}`,
    dropdown: `dropdown_${suffix}`,
    multiselect: `multi_${suffix}`,
    current: `actual_${suffix}`
  }
  const definitions = [
    { fieldKey: keys.text, label: 'Texto', dataType: 'text' },
    { fieldKey: keys.radio, label: 'Radio', dataType: 'radio', options: [{ label: 'Sí', value: 'si' }, { label: 'No', value: 'no' }] },
    { fieldKey: keys.checkboxes, label: 'Checkboxes', dataType: 'checkboxes', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    { fieldKey: keys.dropdown, label: 'Dropdown', dataType: 'dropdown', options: [{ label: 'Pro', value: 'pro' }] },
    { fieldKey: keys.multiselect, label: 'Multiselect', dataType: 'multiselect', options: [{ label: 'Email', value: 'email' }, { label: 'WhatsApp', value: 'whatsapp' }] },
    { fieldKey: keys.current, label: 'Valor actual', dataType: 'text' }
  ]
  let site = null

  try {
    site = await createSite({
      name: `Formulario recuperación ${suffix}`,
      slug: `form-recovery-${suffix}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })
    const prepared = await prepareContactCustomFieldsForStorage(definitions, {
      sourceType: 'native_site',
      sourceId: site.id,
      sourceSiteId: site.id,
      sourceFormId: site.id,
      syncTarget: 'local'
    })
    const currentDefinition = prepared.find(field => field.fieldKey === keys.current)

    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Contacto histórico', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, serializeContactCustomFieldsForDb([
        { id: keys.current, key: keys.current, fieldKey: keys.current, value: 'vigente' },
        { ...currentDefinition, value: 'vigente' }
      ])]
    )

    await db.run(
      `INSERT INTO public_site_submissions (
         id, site_id, form_site_id, contact_id, domain, response_json,
         mapped_fields_json, status, created_at
       ) VALUES (?, ?, ?, ?, 'example.test', '{}', ?, 'received', ?)`,
      [
        `submission_old_${suffix}`,
        site.id,
        site.id,
        contactId,
        JSON.stringify({
          custom: {
            [keys.text]: 'respuesta vieja',
            [keys.radio]: 'no',
            [keys.current]: 'histórico'
          }
        }),
        '2026-08-03T10:00:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
         id, site_id, form_site_id, contact_id, domain, response_json,
         mapped_fields_json, status, created_at
       ) VALUES (?, ?, ?, ?, 'example.test', '{}', ?, 'received', ?)`,
      [
        `submission_new_${suffix}`,
        site.id,
        site.id,
        contactId,
        JSON.stringify({
          custom: {
            [keys.text]: 'respuesta nueva',
            [keys.radio]: 'si',
            [keys.checkboxes]: ['a', 'b'],
            [keys.dropdown]: 'pro',
            [keys.multiselect]: ['email', 'whatsapp'],
            [keys.current]: 'también histórico'
          }
        }),
        '2026-08-04T10:00:00.000Z'
      ]
    )

    const result = await runContactFormCustomFieldsRecovery({
      contactIds: [contactId],
      force: true,
      markComplete: false
    })
    const stored = parseContactCustomFields((await db.get(
      'SELECT custom_fields FROM contacts WHERE id = ?',
      [contactId]
    )).custom_fields)
    const byKey = new Map(stored.map(field => [field.fieldKey, field]))

    assert.equal(result.contactsScanned, 1)
    assert.equal(result.contactsChanged, 1)
    assert.equal(result.fieldsRecovered, 5)
    assert.equal(byKey.get(keys.text)?.value, 'respuesta nueva')
    assert.equal(byKey.get(keys.radio)?.value, 'si')
    assert.deepEqual(byKey.get(keys.checkboxes)?.value, ['a', 'b'])
    assert.equal(byKey.get(keys.dropdown)?.value, 'pro')
    assert.deepEqual(byKey.get(keys.multiselect)?.value, ['email', 'whatsapp'])
    assert.equal(byKey.get(keys.current)?.value, 'vigente')
    assert.equal(stored.filter(field => field.fieldKey === keys.current).length, 1)
    assert.equal(byKey.get(keys.radio)?.dataType, 'radio')
    assert.equal(byKey.get(keys.checkboxes)?.dataType, 'checkboxes')
    assert.equal(byKey.get(keys.dropdown)?.dataType, 'dropdown')
    assert.equal(byKey.get(keys.multiselect)?.dataType, 'multiselect')
  } finally {
    await db.run('DELETE FROM public_site_submissions WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    const definitionsToDelete = await db.all(
      `SELECT id FROM contact_custom_field_definitions
       WHERE field_key IN (${Object.keys(keys).map(() => '?').join(', ')})`,
      Object.values(keys)
    ).catch(() => [])
    for (const definition of definitionsToDelete) {
      await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [definition.id]).catch(() => undefined)
      await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [definition.id]).catch(() => undefined)
    }
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
  }
})
