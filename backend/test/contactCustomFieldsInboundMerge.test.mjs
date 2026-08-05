import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import {
  mergeAndPersistContactCustomFields,
  mutateAndPersistContactCustomFields
} from '../src/services/contactCustomFieldsPersistenceService.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../src/utils/contactCustomFields.js'

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
    '../src/routes/external.routes.js',
    '../src/services/sitesService.js',
    '../src/controllers/contactsController.js',
    '../src/services/automationEngine.js'
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

test('la mezcla colapsa la identidad legacy y materializada del mismo campo', () => {
  const fieldKey = 'presupuesto_mensual'
  const definitionId = 'contact_field_presupuesto'
  const merged = mergeContactCustomFields(
    [{
      id: fieldKey,
      key: fieldKey,
      fieldKey,
      label: fieldKey,
      dataType: 'text',
      value: 'menos_de_10k'
    }],
    [{
      id: definitionId,
      definitionId,
      key: fieldKey,
      fieldKey,
      label: 'Presupuesto mensual',
      dataType: 'dropdown',
      options: [
        { label: 'Menos de $10k', value: 'menos_de_10k' },
        { label: '$10k o más', value: '10k_o_mas' }
      ],
      value: '10k_o_mas'
    }]
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].definitionId, definitionId)
  assert.equal(merged[0].fieldKey, fieldKey)
  assert.equal(merged[0].label, 'Presupuesto mensual')
  assert.equal(merged[0].dataType, 'dropdown')
  assert.equal(merged[0].value, '10k_o_mas')
  assert.deepEqual(merged[0].options.map(option => option.value), ['menos_de_10k', '10k_o_mas'])
})

test('la recuperación sólo rellena ausentes y normaliza duplicados sin pisar el valor actual', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactId = `contact_custom_field_missing_${suffix}`
  const currentKey = `current_${suffix}`
  const missingKey = `missing_${suffix}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Contacto recuperación', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, serializeContactCustomFieldsForDb([
        { id: currentKey, key: currentKey, fieldKey: currentKey, value: 'actual' },
        {
          id: `definition_${currentKey}`,
          definitionId: `definition_${currentKey}`,
          key: currentKey,
          fieldKey: currentKey,
          label: 'Campo actual',
          value: 'actual'
        }
      ])]
    )

    const result = await mutateAndPersistContactCustomFields({
      contactId,
      updates: [
        { id: currentKey, key: currentKey, fieldKey: currentKey, value: 'histórico' },
        { id: missingKey, key: missingKey, fieldKey: missingKey, value: 'recuperado' }
      ],
      onlyIfMissing: true,
      normalizeExisting: true,
      database: db,
      dialect: 'sqlite'
    })

    const stored = parseContactCustomFields((await db.get(
      'SELECT custom_fields FROM contacts WHERE id = ?',
      [contactId]
    )).custom_fields)

    assert.equal(result.changed, true)
    assert.equal(result.appliedUpdates, 1)
    assert.equal(stored.filter(field => field.fieldKey === currentKey).length, 1)
    assert.equal(stored.find(field => field.fieldKey === currentKey)?.value, 'actual')
    assert.equal(stored.find(field => field.fieldKey === missingKey)?.value, 'recuperado')
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('escrituras simultáneas conservan todos los campos del contacto', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactId = `contact_custom_field_concurrent_${suffix}`
  const updates = Array.from({ length: 12 }, (_, index) => ({
    id: `concurrent_${index}_${suffix}`,
    key: `concurrent_${index}_${suffix}`,
    fieldKey: `concurrent_${index}_${suffix}`,
    value: `respuesta-${index}`
  }))

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Contacto concurrente', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    await Promise.all(updates.map(field => mergeAndPersistContactCustomFields({
      contactId,
      updates: [field],
      database: db,
      dialect: 'sqlite'
    })))

    const stored = parseContactCustomFields((await db.get(
      'SELECT custom_fields FROM contacts WHERE id = ?',
      [contactId]
    )).custom_fields)

    assert.equal(stored.length, updates.length)
    assert.deepEqual(
      Object.fromEntries(stored.map(field => [field.fieldKey, field.value])),
      Object.fromEntries(updates.map(field => [field.fieldKey, field.value]))
    )
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
