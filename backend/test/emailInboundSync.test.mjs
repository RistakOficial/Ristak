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

test('syncInboundEmailOnce importa un correo IMAP como mensaje inbound del contacto', async () => {
  await initializeMasterKey()

  const suffix = uniqueId('imap_inbound')
  const fromEmail = `${suffix}@cliente.test`
  const toEmail = 'ventas@example.test'
  const subject = `Pregunta IMAP ${suffix}`

  class FakeImapClient {
    async connect() {}

    async mailboxOpen(path) {
      assert.equal(path, 'INBOX')
      return { path: 'INBOX', exists: 1, uidNext: 42 }
    }

    async *fetch(range, query, options) {
      assert.equal(range, '41:*')
      assert.equal(options.uid, true)
      assert.equal(query.uid, true)
      yield {
        uid: 41,
        emailId: 'email-id-41',
        threadId: 'thread-id-41',
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
    messageId: `<${suffix}@cliente.test>`,
    date: '2026-07-04T18:00:00.000Z',
    attachments: []
  }))

  try {
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
        lastSeenUid: 40
      }
    })
    await setAppConfig('email_smtp_password', encrypt('app-password'))

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
    setEmailImapClientFactoryForTest()
    setEmailMimeParserForTest()
    await db.run('DELETE FROM email_messages WHERE subject = ?', [subject]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [fromEmail]).catch(() => undefined)
    await db.run("DELETE FROM app_config WHERE config_key IN ('email_smtp_config', 'email_smtp_password')").catch(() => undefined)
  }
})
