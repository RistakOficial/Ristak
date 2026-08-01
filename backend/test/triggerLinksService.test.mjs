import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  buildTriggerLinkPublicUrl,
  createTriggerLink,
  getTriggerLink,
  listTriggerLinks,
  normalizeTriggerLinkDestination,
  recordTriggerLinkClick,
  recordTriggerLinkRecipientClick,
  updateTriggerLink
} from '../src/services/triggerLinksService.js'
import {
  buildTriggerLinkRecipientUrl,
  readTriggerLinkRecipientToken
} from '../src/services/triggerLinkRecipientTokenService.js'

test('normalizeTriggerLinkDestination acepta URLs absolutas, dominios y rutas internas seguras', () => {
  assert.equal(normalizeTriggerLinkDestination('https://example.com/demo.pdf'), 'https://example.com/demo.pdf')
  assert.equal(normalizeTriggerLinkDestination('example.com/demo'), 'https://example.com/demo')
  assert.equal(normalizeTriggerLinkDestination('/campaigns/demo'), '/campaigns/demo')
  assert.throws(() => normalizeTriggerLinkDestination('//example.com/trampa'), /ruta interna válida/)
  assert.throws(() => normalizeTriggerLinkDestination('javascript:alert(1)'), /no está permitido/)
  assert.throws(() => normalizeTriggerLinkDestination('solo texto'), /URL válida/)
})

test('createTriggerLink crea ID público, URL pública y permite actualizar destino', async () => {
  const created = await createTriggerLink(
    {
      name: `Enlace prueba ${Date.now()}`,
      destinationUrl: 'example.com/pdf',
      description: 'Prueba automatizada'
    },
    { userId: 'test-user', baseUrl: 'https://app.ristak.test' }
  )

  try {
    assert.match(created.id, /^rstk_trigger_link_[A-Za-z0-9]{20}$/)
    assert.match(created.publicId, /^rstk_link_[A-Za-z0-9]{12}$/)
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
    assert.equal(updated.active, true)

    const saved = await getTriggerLink(created.id, { baseUrl: 'https://app.ristak.test' })
    assert.equal(saved.publicUrl, `https://app.ristak.test/trigger-links/${created.publicId}`)

    const links = await listTriggerLinks({ baseUrl: 'https://app.ristak.test' })
    assert.ok(links.some(link => link.id === created.id))
  } finally {
    await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [created.id]).catch(() => undefined)
    await db.run('DELETE FROM trigger_links WHERE id = ?', [created.id]).catch(() => undefined)
  }
})

test('el enlace personalizado es opaco, único, stateless y atribuye sólo al contacto cifrado', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactAId = `rstk_contact_trigger_a_${suffix}`
  const contactBId = `rstk_contact_trigger_b_${suffix}`
  const visitorId = `visitor_trigger_${suffix}`.slice(0, 120)
  let triggerLink = null

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactAId, '+526560000001', `ana-${suffix}@example.test`, 'Ana Privada', 'Ana', 'Privada']
    )
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactBId, '+526560000002', `bruno-${suffix}@example.test`, 'Bruno Privado', 'Bruno', 'Privado']
    )
    triggerLink = await createTriggerLink({
      name: `Enlace opaco ${suffix}`,
      destinationUrl: 'https://example.test/destino'
    })

    const anaUrl = await buildTriggerLinkRecipientUrl({
      publicId: triggerLink.publicId,
      contactId: contactAId,
      baseUrl: 'https://links.ristak.test'
    })
    const secondAnaUrl = await buildTriggerLinkRecipientUrl({
      publicId: triggerLink.publicId,
      contactId: contactAId,
      baseUrl: 'https://links.ristak.test'
    })
    const brunoUrl = await buildTriggerLinkRecipientUrl({
      publicId: triggerLink.publicId,
      contactId: contactBId,
      baseUrl: 'https://links.ristak.test'
    })

    assert.match(anaUrl, /^https:\/\/links\.ristak\.test\/pce1_[A-Za-z0-9_-]+$/)
    assert.notEqual(anaUrl, secondAnaUrl, 'cada emisión debe usar un token opaco nuevo')
    assert.notEqual(anaUrl, brunoUrl, 'dos contactos nunca deben compartir URL')
    for (const value of [anaUrl, secondAnaUrl, brunoUrl]) {
      assert.equal(new URL(value).search, '')
      assert.ok(!value.includes('contact_id'))
      assert.ok(!value.includes('@'))
      assert.ok(!value.includes('+52656'))
      assert.ok(!value.includes(contactAId))
      assert.ok(!value.includes(contactBId))
    }

    const token = new URL(anaUrl).pathname.slice(1)
    assert.deepEqual(
      await readTriggerLinkRecipientToken(token),
      { publicId: triggerLink.publicId, contactId: contactAId }
    )

    const result = await recordTriggerLinkRecipientClick(token, {
      query: {
        utm_source: 'prueba',
        contact_id: contactBId,
        phone: '+526569999999',
        email: 'intruso@example.test'
      },
      headers: {
        cookie: `ristak_vid=${encodeURIComponent(visitorId)}`,
        'user-agent': 'Ristak trigger test'
      },
      ip: '203.0.113.10'
    })
    assert.equal(result.destinationUrl, 'https://example.test/destino')
    assert.equal(result.event.contactId, contactAId)
    assert.equal(result.event.visitorId, visitorId)
    assert.deepEqual(result.event.query, { utm_source: 'prueba' })

    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    await assert.rejects(
      () => recordTriggerLinkRecipientClick(tampered, { headers: {} }),
      /Enlace de disparo no encontrado/
    )
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactAId, contactBId]).catch(() => undefined)
  }
})

test('el enlace público legacy ignora identidad manipulable en query y registra el clic como anónimo', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `rstk_contact_trigger_legacy_${suffix}`
  let triggerLink = null

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name) VALUES (?, ?)',
      [contactId, 'Contacto que no debe atribuirse']
    )
    triggerLink = await createTriggerLink({
      name: `Enlace legacy ${suffix}`,
      destinationUrl: 'https://example.test/legacy'
    })

    const result = await recordTriggerLinkClick(triggerLink.publicId, {
      query: {
        contact_id: contactId,
        phone: '+526560000000',
        email: 'expuesto@example.test',
        utm_campaign: 'compatibilidad'
      },
      headers: {}
    })
    assert.equal(result.event.contactId, '')
    assert.deepEqual(result.event.query, { utm_campaign: 'compatibilidad' })
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('un enlace desactivado invalida tanto la ruta opaca como la pública legacy', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `rstk_contact_trigger_inactive_${suffix}`
  let triggerLink = null

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name) VALUES (?, ?)',
      [contactId, 'Contacto con trigger desactivado']
    )
    triggerLink = await createTriggerLink({
      name: `Enlace desactivado ${suffix}`,
      destinationUrl: 'https://example.test/inactivo'
    })
    const url = await buildTriggerLinkRecipientUrl({
      publicId: triggerLink.publicId,
      contactId,
      baseUrl: 'https://links.ristak.test'
    })
    await db.run(
      'UPDATE trigger_links SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [triggerLink.id]
    )

    await assert.rejects(
      () => recordTriggerLinkRecipientClick(new URL(url).pathname.slice(1), { headers: {} }),
      /Enlace de disparo no encontrado/
    )
    await assert.rejects(
      () => recordTriggerLinkClick(triggerLink.publicId, { headers: {} }),
      /Enlace de disparo no encontrado/
    )
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
