import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createMessageTemplate,
  createTemplateFolder,
  deleteTemplateFolder,
  updateMessageTemplate
} from '../src/services/messageTemplatesService.js'

test('bloquea edición de plantillas en revisión y permite moverlas de carpeta', async () => {
  const suffix = Date.now()
  const templateName = `pending_review_lock_${suffix}`
  let folder = null

  const basePayload = {
    folderId: null,
    name: templateName,
    description: 'Plantilla pendiente de revisión',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { latitude: '', longitude: '', name: '', address: '' },
    bodyText: 'Hola {{1}}, tu cita es mañana.',
    footerText: '',
    buttons: [],
    variableExamples: {},
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'Maria'
        }
      }
    },
    ycloudTemplateId: `official_${templateName}`,
    ycloudStatus: 'PENDING'
  }

  try {
    folder = await createTemplateFolder({ name: `Revision lock ${suffix}` })
    const template = await createMessageTemplate(basePayload)

    await assert.rejects(
      () => updateMessageTemplate(template.id, {
        ...basePayload,
        bodyText: 'Hola {{1}}, esta edición no debe pasar.'
      }),
      (error) => {
        assert.equal(error.statusCode, 409)
        assert.match(error.message, /en revisión/i)
        return true
      }
    )

    const moved = await updateMessageTemplate(template.id, {
      ...basePayload,
      folderId: folder.id
    })
    assert.equal(moved.folderId, folder.id)
    assert.equal(moved.bodyText, basePayload.bodyText)
    assert.equal(moved.ycloudStatus, 'PENDING')
  } finally {
    await db.run('DELETE FROM whatsapp_message_templates WHERE name = ?', [templateName])
    await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [templateName])
    if (folder) await deleteTemplateFolder(folder.id)
  }
})
