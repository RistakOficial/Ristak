import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  archiveContactCustomFieldFolder,
  createContactCustomFieldFolder,
  listContactCustomFieldDefinitions,
  updateContactCustomFieldDefinition,
  upsertContactCustomFieldDefinition
} from '../src/services/contactCustomFieldDefinitionsService.js'

test('custom field folders keep fields and normalize them as unfiled when removed', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  let folder
  let definition

  try {
    folder = await createContactCustomFieldFolder({
      name: `Datos ${suffix}`,
      description: 'Campos agrupados'
    })
    definition = await upsertContactCustomFieldDefinition({
      fieldKey: `folder_field_${suffix}`,
      label: `Campo ${suffix}`,
      dataType: 'text',
      folderId: folder.id,
      createOnly: true,
      sourceType: 'manual'
    })

    assert.equal(definition.folderId, folder.id)
    assert.equal(definition.folderName, folder.name)
    assert.equal(definition.fieldGroup, folder.name)

    const movedOut = await updateContactCustomFieldDefinition(definition.definitionId, { folderId: '' })
    assert.equal(movedOut.folderId, '')
    assert.equal(movedOut.fieldGroup, 'general')

    await updateContactCustomFieldDefinition(definition.definitionId, { folderId: folder.id })
    await archiveContactCustomFieldFolder(folder.id)

    const preserved = (await listContactCustomFieldDefinitions({ includeArchived: true }))
      .find(field => field.definitionId === definition.definitionId)
    assert.equal(preserved?.folderId, '')
    assert.equal(preserved?.fieldGroup, 'general')
    assert.equal(preserved?.label, definition.label)
  } finally {
    if (definition?.definitionId) {
      await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [definition.definitionId]).catch(() => undefined)
      await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [definition.definitionId]).catch(() => undefined)
    }
    if (folder?.id) {
      await db.run('DELETE FROM contact_custom_field_folders WHERE id = ?', [folder.id]).catch(() => undefined)
    }
  }
})
