import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'

import { db } from '../src/config/database.js'
import triggerLinkRecipientsRoutes from '../src/routes/triggerLinkRecipients.routes.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import { createTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'

test('la ruta raíz consume sólo tokens opacos y deja pasar slugs normales de Sites', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `rstk_contact_route_trigger_${suffix}`
  let triggerLink = null
  let server = null

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name) VALUES (?, ?)',
      [contactId, 'Contacto ruta trigger']
    )
    triggerLink = await createTriggerLink({
      name: `Trigger ruta ${suffix}`,
      destinationUrl: 'https://example.test/destino-ruta'
    })
    const token = await createTriggerLinkRecipientToken({
      publicId: triggerLink.publicId,
      contactId
    })

    const app = express()
    app.use('/', triggerLinkRecipientsRoutes)
    app.get('/:slug', (_req, res) => res.status(204).end())
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    })
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const redirect = await fetch(`${baseUrl}/${encodeURIComponent(token)}`, {
      redirect: 'manual'
    })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), 'https://example.test/destino-ruta')
    assert.equal(redirect.headers.get('cache-control'), 'no-store')
    assert.equal(redirect.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(redirect.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')

    const normalSlug = await fetch(`${baseUrl}/pagina-normal`, { redirect: 'manual' })
    assert.equal(normalSlug.status, 204)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
