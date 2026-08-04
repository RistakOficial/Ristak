import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import { mergeAndPersistContactCustomFields } from '../src/services/contactCustomFieldsPersistenceService.js'
import { parseContactCustomFields, serializeContactCustomFieldsForDb } from '../src/utils/contactCustomFields.js'

await databaseReady

test('una sincronización externa conserva respuestas de texto y radio guardadas por formularios', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactId = `contact_custom_field_merge_${suffix}`
  const localFields = [
    {
      id: `local_text_${suffix}`,
      definitionId: `local_text_${suffix}`,
      fieldKey: 'situacion_consultorio',
      key: 'situacion_consultorio',
      label: '¿Cuál es la situación actual de tu consultorio?',
      dataType: 'textarea',
      value: 'Quiero atraer más pacientes',
      sourceType: 'imported_html',
      syncTarget: 'local'
    },
    {
      id: `local_radio_${suffix}`,
      definitionId: `local_radio_${suffix}`,
      fieldKey: 'inversion_minima',
      key: 'inversion_minima',
      label: '¿Tienes el monto disponible?',
      dataType: 'radio',
      options: [
        { label: 'Sí', value: 'si_disponible' },
        { label: 'No', value: 'no_disponible' }
      ],
      value: 'si_disponible',
      sourceType: 'imported_html',
      syncTarget: 'local'
    }
  ]

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Contacto formulario', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, serializeContactCustomFieldsForDb(localFields)]
    )

    await mergeAndPersistContactCustomFields({
      contactId,
      updates: [{
        id: `ghl_field_${suffix}`,
        fieldKey: 'contact.campaign_id',
        key: 'contact.campaign_id',
        label: 'campaign_id',
        dataType: 'TEXT',
        value: 'campaign-1'
      }],
      database: db,
      dialect: 'sqlite'
    })

    await mergeAndPersistContactCustomFields({
      contactId,
      updates: [{
        id: `ghl_field_${suffix}`,
        fieldKey: 'contact.campaign_id',
        key: 'contact.campaign_id',
        label: 'campaign_id',
        dataType: 'TEXT',
        value: 'campaign-2'
      }],
      database: db,
      dialect: 'sqlite'
    })

    const stored = parseContactCustomFields((await db.get(
      'SELECT custom_fields FROM contacts WHERE id = ?',
      [contactId]
    )).custom_fields)

    assert.equal(stored.length, 3)
    assert.equal(stored.find(field => field.fieldKey === 'situacion_consultorio')?.value, 'Quiero atraer más pacientes')
    assert.equal(stored.find(field => field.fieldKey === 'inversion_minima')?.value, 'si_disponible')
    assert.equal(stored.find(field => field.fieldKey === 'contact.campaign_id')?.value, 'campaign-2')
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('los ingresos externos no reemplazan directamente el arreglo completo de campos personalizados', () => {
  const sourceFiles = [
    '../src/controllers/webhooksController.js',
    '../src/services/highlevelSyncService.js',
    '../src/routes/external.routes.js'
  ]

  for (const relativePath of sourceFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /custom_fields\s*=\s*COALESCE\((?:EXCLUDED|excluded)\.custom_fields,\s*contacts\.custom_fields\)/,
      `${relativePath} no debe reemplazar campos locales con el payload externo`
    )
    assert.match(source, /mergeAndPersistContactCustomFields/)
  }
})
