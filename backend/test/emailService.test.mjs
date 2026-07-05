import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig } from '../src/config/database.js'
import { decrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  connectEmail,
  detectEmailProvider,
  getEmailSignature,
  saveEmailSignature,
  sendEmail,
  sendEmailToContact,
  setEmailImapClientFactoryForTest,
  setEmailMxResolverForTest,
  setEmailTransportFactoryForTest
} from '../src/services/emailService.js'

const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'

function setHappyPathImapClientFactory(optionsLog = []) {
  setEmailImapClientFactoryForTest((options) => {
    optionsLog.push(options)
    return {
      connect: async () => true,
      mailboxOpen: async (mailbox) => ({
        path: mailbox,
        exists: 0,
        uidNext: 1
      }),
      logout: async () => true
    }
  })
}

async function snapshotAppConfig(keys = [], callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = placeholders
    ? await db.all(
        `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
        uniqueKeys
      )
    : []

  try {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    return await callback()
  } finally {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

test('detecta proveedor SMTP por registros MX del dominio', async () => {
  setEmailMxResolverForTest(async (domain) => {
    assert.equal(domain, 'clinicademo.com')
    return [{ exchange: 'aspmx.l.google.com.', priority: 1 }]
  })

  try {
    const detection = await detectEmailProvider({ email: 'Ventas@ClinicaDemo.com' })

    assert.equal(detection.email, 'ventas@clinicademo.com')
    assert.equal(detection.domain, 'clinicademo.com')
    assert.equal(detection.provider.id, 'google')
    assert.equal(detection.provider.detectedBy, 'mx')
    assert.equal(detection.smtp.host, 'smtp.gmail.com')
    assert.equal(detection.smtp.port, 587)
    assert.equal(detection.smtp.security, 'starttls')
    assert.equal(detection.smtp.username, 'ventas@clinicademo.com')
    assert.equal(detection.mx.found, true)
  } finally {
    setEmailMxResolverForTest(null)
  }
})

test('conecta correo con datos simples, prueba envío y guarda password cifrado', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY], async () => {
    const transportOptions = []
    const sentMessages = []

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest((options) => {
      transportOptions.push(options)
      return {
        verify: async () => true,
        sendMail: async (message) => {
          sentMessages.push(message)
          return {
            messageId: 'test-message-id',
            accepted: [message.to],
            rejected: []
          }
        }
      }
    })
    const imapOptions = []
    setHappyPathImapClientFactory(imapOptions)

    try {
      const status = await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })

      assert.equal(status.connected, true)
      assert.equal(status.configured, true)
      assert.equal(status.provider, 'google')
      assert.equal(status.providerLabel, 'Google Gmail / Workspace')
      assert.equal(status.smtp.host, 'smtp.gmail.com')
      assert.equal(status.smtp.port, 587)
      assert.equal(status.smtp.security, 'starttls')
      assert.equal(status.smtp.hasPassword, true)
      assert.equal(status.inbound.enabled, true)
      assert.equal(status.inbound.connected, true)
      assert.equal(status.inbound.host, 'imap.gmail.com')
      assert.equal(status.inbound.port, 993)
      assert.equal(status.inbound.security, 'ssl')
      assert.equal(status.inbound.mailbox, 'INBOX')
      assert.equal(status.sender.fromEmail, 'ventas@clinicademo.com')
      assert.equal(status.sender.fromName, 'Clínica Demo')
      assert.ok(status.timestamps.lastVerifiedAt)
      assert.ok(status.timestamps.lastTestAt)

      assert.equal(transportOptions.length, 1)
      assert.equal(transportOptions[0].host, 'smtp.gmail.com')
      assert.equal(transportOptions[0].port, 587)
      assert.equal(transportOptions[0].secure, false)
      assert.equal(transportOptions[0].requireTLS, true)
      assert.equal(transportOptions[0].auth.user, 'ventas@clinicademo.com')
      assert.equal(transportOptions[0].auth.pass, 'app-password-demo')
      assert.equal(imapOptions.length, 1)
      assert.equal(imapOptions[0].host, 'imap.gmail.com')
      assert.equal(imapOptions[0].port, 993)
      assert.equal(imapOptions[0].secure, true)
      assert.equal(imapOptions[0].auth.user, 'ventas@clinicademo.com')
      assert.equal(imapOptions[0].auth.pass, 'app-password-demo')

      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].to, 'ventas@clinicademo.com')
      assert.match(sentMessages[0].from, /Clínica Demo/)

      const encryptedPassword = await getAppConfig(EMAIL_PASSWORD_KEY)
      assert.notEqual(encryptedPassword, 'app-password-demo')
      assert.equal(decrypt(encryptedPassword), 'app-password-demo')
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
    }
  })
})

test('respeta cuando la recepcion de correos se desactiva explicitamente', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY], async () => {
    const imapOptions = []

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => ({
        messageId: 'test-message-id',
        accepted: [message.to],
        rejected: []
      })
    }))
    setHappyPathImapClientFactory(imapOptions)

    try {
      const status = await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo',
        inbound: { enabled: false }
      })

      assert.equal(status.connected, true)
      assert.equal(status.inbound.enabled, false)
      assert.equal(status.inbound.connected, false)
      assert.equal(imapOptions.length, 0)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
    }
  })
})

test('guarda firma saneada para correos salientes', async () => {
  await snapshotAppConfig([EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const signature = await saveEmailSignature({
      enabled: true,
      includeBeforeQuotedText: true,
      html: '<p><strong>Raúl</strong><script>alert(1)</script><a href="javascript:alert(1)" onclick="bad()">link</a></p>'
    })

    assert.equal(signature.enabled, true)
    assert.equal(signature.includeBeforeQuotedText, true)
    assert.match(signature.html, /<strong>Raúl<\/strong>/)
    assert.doesNotMatch(signature.html, /script/i)
    assert.doesNotMatch(signature.html, /javascript/i)
    assert.doesNotMatch(signature.html, /onclick/i)

    const stored = await getEmailSignature()
    assert.equal(stored.enabled, true)
    assert.match(stored.text, /Raúl/)
  })
})

test('agrega la firma guardada al enviar correos', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const sentMessages = []

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `message-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })
      await saveEmailSignature({
        enabled: true,
        includeBeforeQuotedText: true,
        html: '<div><strong>Raúl Gómez</strong><br><a href="mailto:raul@example.com">raul@example.com</a></div>'
      })

      await sendEmail({
        to: 'cliente@example.com',
        subject: 'Hola',
        text: 'Mensaje principal',
        html: '<p>Mensaje principal</p><blockquote>Texto citado</blockquote>'
      })

      assert.equal(sentMessages.length, 2)
      const outgoing = sentMessages[1]
      assert.match(outgoing.html, /data-ristak-email-signature/)
      assert.match(outgoing.html, /Raúl Gómez/)
      assert.ok(outgoing.html.indexOf('Raúl Gómez') < outgoing.html.indexOf('<blockquote>Texto citado</blockquote>'))
      assert.match(outgoing.text, /Mensaje principal/)
      assert.match(outgoing.text, /Raúl Gómez/)

      await sendEmail({
        to: 'cliente@example.com',
        subject: 'Sin firma',
        text: 'Mensaje sin firma',
        html: '<p>Mensaje sin firma</p>',
        includeSignature: false
      })

      assert.equal(sentMessages.length, 3)
      assert.doesNotMatch(sentMessages[2].html, /data-ristak-email-signature/)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
    }
  })
})

test('sendEmailToContact envía correo y guarda el mensaje en el historial del contacto', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = Date.now().toString(36)
    const contactId = `rstk_contact_email_history_${suffix}`
    const sentMessages = []

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `smtp-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      await db.run(
        `INSERT INTO contacts (id, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?)`,
        [contactId, `cliente-${suffix}@example.com`, 'Cliente Email', 'Cliente', '{}']
      )
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })

      const result = await sendEmailToContact({
        contactId,
        subject: 'Seguimiento',
        text: 'Hola, te comparto la información.',
        externalId: `email_test_${suffix}`
      })

      assert.equal(result.status, 'sent')
      assert.equal(result.localMessageId, `email_test_${suffix}`)
      assert.equal(sentMessages.length, 2)
      assert.equal(sentMessages[1].to, `cliente-${suffix}@example.com`)

      const stored = await db.get('SELECT * FROM email_messages WHERE id = ?', [`email_test_${suffix}`])
      assert.equal(stored.contact_id, contactId)
      assert.equal(stored.status, 'sent')
      assert.equal(stored.to_email, `cliente-${suffix}@example.com`)
      assert.equal(stored.subject, 'Seguimiento')
      assert.equal(stored.message_text, 'Hola, te comparto la información.')
      assert.equal(stored.smtp_message_id, 'smtp-2')
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})
