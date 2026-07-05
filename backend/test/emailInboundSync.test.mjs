import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  setEmailImapClientFactoryForTest,
  setEmailMimeParserForTest,
  syncInboundEmailOnce
} from '../src/services/emailService.js'

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function installSingleInboundMessage({ fromEmail, toEmail, subject, uid = 41 }) {
  class FakeImapClient {
    async connect() {}

    async mailboxOpen(path) {
      assert.equal(path, 'INBOX')
      return { path: 'INBOX', exists: 1, uidNext: 42 }
    }

    async *fetch(range, query, options) {
      assert.equal(range, `${uid}:*`)
      assert.equal(options.uid, true)
      assert.equal(query.uid, true)
      yield {
        uid,
        emailId: `email-id-${uid}`,
        threadId: `thread-id-${uid}`,
        flags: new Set(['\\Seen']),
        internalDate: new Date('2026-07-04T18:00:00.000Z'),
        source: Buffer.from('raw email')
      }
    }

    async logout() {}
  }

  setEmailImapClientFactoryForTest(() => new FakeImapClient())
  setEmailMimeParserForTest(async () => ({
    from: { name: 'Cliente IMAP', address: fromEmail },
    to: [{ name: 'Ventas', address: toEmail }],
    replyTo: [{ name: 'Cliente IMAP', address: fromEmail }],
    subject,
    text: 'Hola, quiero informacion.',
    html: '<p>Hola, quiero informacion.</p>',
    messageId: `<imap-${uid}-${fromEmail}>`,
    date: '2026-07-04T18:00:00.000Z',
    attachments: []
  }))
}

async function configureInboundEmail({ toEmail, createContactsFromUnknownSenders }) {
  await setAppConfig('email_smtp_config', {
    connected: true,
    host: 'smtp.example.test',
    username: toEmail,
    fromEmail: toEmail,
    fromName: 'Ventas',
    inbound: {
      enabled: true,
      host: 'imap.example.test',
      port: 993,
      security: 'ssl',
      username: toEmail,
      mailbox: 'INBOX',
      lastSeenUid: 40,
      ...(createContactsFromUnknownSenders === undefined ? {} : { createContactsFromUnknownSenders })
    }
  })
  await setAppConfig('email_smtp_password', encrypt('app-password'))
}

async function cleanupInboundTest({ fromEmail, subject }) {
  setEmailImapClientFactoryForTest()
  setEmailMimeParserForTest()
  await db.run('DELETE FROM email_messages WHERE subject = ?', [subject]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE email = ?', [fromEmail]).catch(() => undefined)
  await db.run("DELETE FROM app_config WHERE config_key IN ('email_smtp_config', 'email_smtp_password')").catch(() => undefined)
}

test('syncInboundEmailOnce ignora correos de desconocidos por default sin guardar contacto ni correo', async () => {
  await initializeMasterKey()

  const suffix = uniqueId('imap_unknown_default')
  const fromEmail = `${suffix}@cliente.test`
  const toEmail = 'ventas@example.test'
  const subject = `Desconocido ${suffix}`

  installSingleInboundMessage({ fromEmail, toEmail, subject })

  try {
    await configureInboundEmail({ toEmail })

    const result = await syncInboundEmailOnce({ reason: 'test' })

    assert.equal(result.skipped, false)
    assert.equal(result.imported, 0)
    assert.equal(result.seen, 1)
    assert.equal(result.lastSeenUid, 41)

    const contact = await db.get('SELECT id, full_name, email, source FROM contacts WHERE email = ?', [fromEmail])
    assert.equal(contact, null)

    const message = await db.get('SELECT * FROM email_messages WHERE subject = ?', [subject])
    assert.equal(message, null)

    const config = JSON.parse(await getAppConfig('email_smtp_config'))
    assert.equal(config.inbound.lastSeenUid, 41)
    assert.equal(config.inbound.lastError, null)
  } finally {
    await cleanupInboundTest({ fromEmail, subject })
  }
})

test('syncInboundEmailOnce asocia correos inbound a contactos existentes sin crear duplicados', async () => {
  await initializeMasterKey()

  const suffix = uniqueId('imap_existing_contact')
  const contactId = `rstk_contact_${suffix}`
  const fromEmail = `${suffix}@cliente.test`
  const toEmail = 'ventas@example.test'
  const subject = `Contacto existente ${suffix}`

  installSingleInboundMessage({ fromEmail, toEmail, subject })

  try {
    await configureInboundEmail({ toEmail })
    await db.run(
      `INSERT INTO contacts (id, email, full_name, first_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, fromEmail, 'Cliente Existente', 'Cliente', 'manual']
    )

    const result = await syncInboundEmailOnce({ reason: 'test' })

    assert.equal(result.skipped, false)
    assert.equal(result.imported, 1)
    assert.equal(result.lastSeenUid, 41)

    const contactCount = await db.get('SELECT COUNT(*) AS total FROM contacts WHERE LOWER(email) = LOWER(?)', [fromEmail])
    assert.equal(contactCount.total, 1)

    const message = await db.get('SELECT * FROM email_messages WHERE subject = ?', [subject])
    assert.equal(message?.contact_id, contactId)
    assert.equal(message?.direction, 'inbound')
    assert.equal(message?.status, 'delivered')
    assert.equal(message?.from_email, fromEmail)
  } finally {
    await cleanupInboundTest({ fromEmail, subject })
  }
})

test('syncInboundEmailOnce crea contacto desde correo desconocido solo cuando el ajuste esta activo', async () => {
  await initializeMasterKey()

  const suffix = uniqueId('imap_inbound')
  const fromEmail = `${suffix}@cliente.test`
  const toEmail = 'ventas@example.test'
  const subject = `Pregunta IMAP ${suffix}`

  installSingleInboundMessage({ fromEmail, toEmail, subject })

  try {
    await configureInboundEmail({ toEmail, createContactsFromUnknownSenders: true })

    const result = await syncInboundEmailOnce({ reason: 'test' })

    assert.equal(result.skipped, false)
    assert.equal(result.imported, 1)
    assert.equal(result.lastSeenUid, 41)

    const contact = await db.get('SELECT id, full_name, email, source FROM contacts WHERE email = ?', [fromEmail])
    assert.equal(contact?.email, fromEmail)
    assert.equal(contact?.full_name, 'Cliente IMAP')
    assert.equal(contact?.source, 'email_inbound')

    const message = await db.get('SELECT * FROM email_messages WHERE subject = ?', [subject])
    assert.equal(message?.contact_id, contact.id)
    assert.equal(message?.direction, 'inbound')
    assert.equal(message?.status, 'delivered')
    assert.equal(message?.from_email, fromEmail)
    assert.equal(message?.to_email, toEmail)
    assert.equal(message?.message_text, 'Hola, quiero informacion.')
    assert.match(message?.raw_payload_json || '', /"provider":"imap"/)

    const config = JSON.parse(await getAppConfig('email_smtp_config'))
    assert.equal(config.inbound.lastSeenUid, 41)
    assert.equal(config.inbound.lastError, null)
  } finally {
    await cleanupInboundTest({ fromEmail, subject })
  }
})
