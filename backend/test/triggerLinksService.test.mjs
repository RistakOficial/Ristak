import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  buildTriggerLinkPublicUrl,
  createTriggerLink,
  getTriggerLink,
  listTriggerLinks,
  normalizeTriggerLinkDestination,
  updateTriggerLink
} from '../src/services/triggerLinksService.js'

test('normalizeTriggerLinkDestination acepta URLs absolutas, dominios y rutas internas seguras', () => {
  assert.equal(normalizeTriggerLinkDestination('https://example.com/demo.pdf'), 'https://example.com/demo.pdf')
  assert.equal(normalizeTriggerLinkDestination('example.com/demo'), 'https://example.com/demo')
  assert.equal(normalizeTriggerLinkDestination('/campaigns/demo'), '/campaigns/demo')
  assert.throws(() => normalizeTriggerLinkDestination('//example.com/trampa'), /ruta interna valida/)
  assert.throws(() => normalizeTriggerLinkDestination('javascript:alert(1)'), /no esta permitido/)
  assert.throws(() => normalizeTriggerLinkDestination('solo texto'), /URL valida/)
})

test('createTriggerLink crea ID publico, URL publica y permite actualizar destino', async () => {
  const created = await createTriggerLink(
    {
      name: `Enlace prueba ${Date.now()}`,
      destinationUrl: 'example.com/pdf',
      description: 'Prueba automatizada'
    },
    { userId: 'test-user', baseUrl: 'https://app.ristak.test' }
  )

  try {
    assert.match(created.id, /^trigger_link_/)
    assert.match(created.publicId, /^[a-zA-Z0-9_-]{8,}$/)
    assert.equal(created.destinationUrl, 'https://example.com/pdf')
    assert.equal(created.publicUrl, `https://app.ristak.test/trigger-links/${created.publicId}`)
    assert.equal(buildTriggerLinkPublicUrl(created, 'https://app.ristak.test/'), created.publicUrl)

    const updated = await updateTriggerLink(
      created.id,
      { name: 'Enlace actualizado', destinationUrl: '/descarga', active: false },
      { baseUrl: 'https://app.ristak.test' }
    )
    assert.equal(updated.name, 'Enlace actualizado')
    assert.equal(updated.destinationUrl, '/descarga')
    assert.equal(updated.active, false)

    const saved = await getTriggerLink(created.id, { baseUrl: 'https://app.ristak.test' })
    assert.equal(saved.publicUrl, `https://app.ristak.test/trigger-links/${created.publicId}`)

    const links = await listTriggerLinks({ baseUrl: 'https://app.ristak.test' })
    assert.ok(links.some(link => link.id === created.id))
  } finally {
    await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [created.id]).catch(() => undefined)
    await db.run('DELETE FROM trigger_links WHERE id = ?', [created.id]).catch(() => undefined)
  }
})
