import test, { beforeEach, afterEach } from 'node:test'
import { mockRoutableEmailDns, resetEmailRecipientDns } from './helpers/emailRecipientDns.mjs'
import { setEmailRecipientResolverFactoryForTest } from '../src/services/emailRecipientService.js'
import assert from 'node:assert/strict'
import { db, getAppConfig } from '../src/config/database.js'
import { decrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { createVariableField } from '../src/services/variableFieldsService.js'
import {
  connectEmail,
  detectEmailProvider,
  getEmailSignature,
  saveEmailSignature,
  saveInboundEmailSettings,
  sendEmail,
  sendEmailToContact,
  setEmailImapClientFactoryForTest,
  setEmailMxResolverForTest,
  setEmailTransportFactoryForTest
} from '../src/services/emailService.js'
import { sendEmailView } from '../src/controllers/emailController.js'

const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'
beforeEach(mockRoutableEmailDns)
afterEach(resetEmailRecipientDns)

test('un destinatario sin ruta no llega al SMTP ni marca como rota la cuenta remitente', async () => {
  await initializeMasterKey()
  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY], async () => {
    const messages = []
    setEmailMxResolverForTest(async () => [{ exchange: 'aspmx.l.google.com.', priority: 1 }])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async message => { messages.push(message); return { messageId: 'test-connect', accepted: [message.to], rejected: [] } }
    }))
    try {
      await connectEmail({ fromEmail: 'ventas@example.test', fromName: 'Cuenta de prueba', password: 'unit-test-only', inbound: { enabled: false } })
      const previous = await getAppConfig(EMAIL_CONFIG_KEY)
      const initialCount = messages.length
      setEmailRecipientResolverFactoryForTest(() => ({ resolveMx: async () => [{ exchange: '0.0.0.0.', priority: 1000 }] }))
      await assert.rejects(sendEmail({ to: 'bien@bien.com', subject: 'Cita', text: 'Prueba' }), error => error.code === 'email_recipient_unroutable')
      assert.equal(messages.length, initialCount)
      assert.deepEqual(await getAppConfig(EMAIL_CONFIG_KEY), previous)
      setEmailRecipientResolverFactoryForTest(() => ({ resolveMx: async () => { throw Object.assign(new Error('temporary'), { code: 'ESERVFAIL' }) } }))
      await assert.rejects(sendEmail({ to: 'bueno@example.test', subject: 'Cita', text: 'Prueba' }), error => error.code === 'email_recipient_dns_unavailable')
      assert.equal(messages.length, initialCount)
      assert.deepEqual(await getAppConfig(EMAIL_CONFIG_KEY), previous)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
    }
  })
})

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
      assert.equal(status.inbound.createContactsFromUnknownSenders, false)
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

      const updatedStatus = await saveInboundEmailSettings({ createContactsFromUnknownSenders: true })
      assert.equal(updatedStatus.inbound.createContactsFromUnknownSenders, true)
      const storedConfig = JSON.parse(await getAppConfig(EMAIL_CONFIG_KEY))
      assert.equal(storedConfig.inbound.createContactsFromUnknownSenders, true)
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

test('sendEmailToContact resuelve variables en la firma sin inyectar HTML ni reinterpretar tokens insertados', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const contactId = `rstk_contact_email_signature_variables_${suffix}`
    const externalId = `email_signature_variables_${suffix}`
    const customFieldKey = `puesto_${suffix}`
    const sentMessages = []
    const variableFields = []

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `smtp-signature-variables-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      const fieldB = await createVariableField({
        label: `Variable firma B ${suffix}`,
        fieldKey: `email_signature_b_${suffix}`,
        value: `VALOR_B_NO_DEBE_APARECER_${suffix}`
      })
      variableFields.push(fieldB)
      const fieldA = await createVariableField({
        label: `Variable firma A ${suffix}`,
        fieldKey: `email_signature_a_${suffix}`,
        value: `Cuenta <script>alert("cuenta")</script> & ${fieldB.parameter}`
      })
      variableFields.push(fieldA)
      const customFieldValue = `Directora <img src=x onerror="contact()"> & ${fieldB.parameter}`

      await db.run(
        `INSERT INTO contacts (id, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?)`,
        [
          contactId,
          `firma-${suffix}@example.com`,
          'Contacto Firma',
          'Contacto',
          JSON.stringify({ [customFieldKey]: customFieldValue })
        ]
      )
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })
      await saveEmailSignature({
        enabled: true,
        includeBeforeQuotedText: true,
        html: `<p><strong>Cuenta:</strong> ${fieldA.parameter}</p>` +
          `<p><strong>Contacto:</strong> {{contact.custom.${customFieldKey}}}</p>`,
        text: `Cuenta: ${fieldA.parameter}\nContacto: {{contact.custom.${customFieldKey}}}`
      })

      await sendEmailToContact({
        contactId,
        subject: 'Firma con variables',
        text: 'Mensaje principal',
        html: '<p>Mensaje principal</p>',
        externalId
      })

      assert.equal(sentMessages.length, 2)
      const outgoing = sentMessages[1]
      assert.match(outgoing.html, /data-ristak-email-signature/)
      assert.ok(outgoing.html.includes(
        `Cuenta &lt;script&gt;alert(&quot;cuenta&quot;)&lt;/script&gt; &amp; ${fieldB.parameter}`
      ))
      assert.ok(outgoing.html.includes(
        `Directora &lt;img src=x &amp; ${fieldB.parameter}`
      ))
      assert.doesNotMatch(outgoing.html, /<script\b|<img\b|onerror="/i)
      assert.ok(outgoing.text.includes(`Cuenta: Cuenta <script>alert("cuenta")</script> & ${fieldB.parameter}`))
      assert.ok(outgoing.text.includes(`Contacto: ${customFieldValue}`))
      assert.ok(!outgoing.html.includes(fieldA.parameter))
      assert.ok(!outgoing.html.includes(fieldB.value))
      assert.ok(!outgoing.text.includes(fieldA.parameter))
      assert.ok(!outgoing.text.includes(fieldB.value))
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
      for (const field of variableFields) {
        await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
      }
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
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

test('sendEmailToContact adjunta PDF y XML sin guardar los binarios en el historial', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = Date.now().toString(36)
    const contactId = `rstk_contact_email_fiscal_${suffix}`
    const externalId = `email_fiscal_${suffix}`
    const sentMessages = []
    const pdf = Buffer.from('%PDF-1.4 factura fiscal')
    const xml = Buffer.from('<?xml version="1.0"?><cfdi/>')

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `smtp-fiscal-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      await db.run(
        `INSERT INTO contacts (id, email, full_name, first_name)
         VALUES (?, ?, 'Cliente Fiscal', 'Cliente')`,
        [contactId, `fiscal-${suffix}@example.com`]
      )
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })

      await sendEmailToContact({
        contactId,
        subject: 'Factura fiscal',
        text: 'Adjuntamos PDF y XML.',
        externalId,
        attachments: [
          { filename: 'factura.pdf', content: pdf, contentType: 'application/pdf' },
          { filename: 'factura.xml', content: xml, contentType: 'application/xml' }
        ]
      })

      assert.equal(sentMessages.length, 2)
      const outgoing = sentMessages[1]
      assert.equal(outgoing.attachments.length, 2)
      assert.equal(outgoing.attachments[0].content.toString(), pdf.toString())
      assert.equal(outgoing.attachments[1].content.toString(), xml.toString())

      const stored = await db.get(
        'SELECT raw_payload_json FROM email_messages WHERE id = ?',
        [externalId]
      )
      const raw = JSON.parse(stored.raw_payload_json)
      assert.deepEqual(raw.attachments, [
        { filename: 'factura.pdf', contentType: 'application/pdf', sizeBytes: pdf.length },
        { filename: 'factura.xml', contentType: 'application/xml', sizeBytes: xml.length }
      ])
      assert.doesNotMatch(stored.raw_payload_json, /factura fiscal|<cfdi\/>/)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  })
})

test('sendEmailToContact bloquea contactos archivados antes de llegar al SMTP', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const contactId = `rstk_contact_email_archived_${suffix}`
    const sentMessages = []

    setEmailMxResolverForTest(async () => [{ exchange: 'aspmx.l.google.com.', priority: 1 }])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async message => {
        sentMessages.push(message)
        return { messageId: `smtp-${sentMessages.length}`, accepted: [message.to], rejected: [] }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      await db.run(
        `INSERT INTO contacts (id, email, full_name, deleted_at)
         VALUES (?, ?, 'Contacto archivado', CURRENT_TIMESTAMP)`,
        [contactId, `archivado-${suffix}@example.com`]
      )
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })
      const connectionTestCount = sentMessages.length

      await assert.rejects(
        sendEmailToContact({ contactId, subject: 'No enviar', text: 'Este correo debe bloquearse.' }),
        error => error.status === 404
      )
      assert.equal(sentMessages.length, connectionTestCount)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  })
})

test('sendEmailToContact resuelve variables en asunto, texto y HTML sin permitir inyectar markup', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const contactId = `rstk_contact_email_variables_${suffix}`
    const externalId = `email_variables_${suffix}`
    const sentMessages = []
    const unsafeContactName = 'Ana <img src=x onerror="alert(1)">'
    const unsafeVariableValue = 'VIP <script>alert("variable")</script> & seguro'
    let variableField

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `smtp-variables-${sentMessages.length}`,
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
        [
          contactId,
          `variables-${suffix}@example.com`,
          unsafeContactName,
          unsafeContactName,
          '{}'
        ]
      )
      variableField = await createVariableField({
        label: `Oferta correo ${suffix}`,
        fieldKey: `email_offer_${suffix}`,
        value: unsafeVariableValue
      })
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })

      await sendEmailToContact({
        contactId,
        subject: `Seguimiento para {{contact.first_name}} · ${variableField.parameter}`,
        text: `Texto: {{contact.first_name}} / ${variableField.parameter}`,
        html: `<h1>{{contact.first_name}}</h1><p>${variableField.parameter}</p>`,
        externalId,
        includeSignature: false
      })

      assert.equal(sentMessages.length, 2)
      const outgoing = sentMessages[1]
      assert.equal(outgoing.subject, `Seguimiento para ${unsafeContactName} · ${unsafeVariableValue}`)
      assert.equal(outgoing.text, `Texto: ${unsafeContactName} / ${unsafeVariableValue}`)
      assert.equal(
        outgoing.html,
        '<h1>Ana &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h1>' +
          '<p>VIP &lt;script&gt;alert(&quot;variable&quot;)&lt;/script&gt; &amp; seguro</p>'
      )
      assert.doesNotMatch(outgoing.html, /<img\b|<script\b|onerror="/i)

      const stored = await db.get('SELECT subject, message_text, html_body FROM email_messages WHERE id = ?', [externalId])
      assert.equal(stored.subject, outgoing.subject)
      assert.equal(stored.message_text, outgoing.text)
      assert.equal(stored.html_body, outgoing.html)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
      if (variableField?.id) {
        await db.run('DELETE FROM variable_fields WHERE id = ?', [variableField.id]).catch(() => undefined)
      }
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  })
})

test('sendEmailView ignora controles internos del body y resuelve con el usuario autenticado', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY, EMAIL_SIGNATURE_CONFIG_KEY], async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const authenticatedUsername = `email_view_authenticated_${suffix}`
    const attackerUsername = `email_view_attacker_${suffix}`
    const authenticatedEmail = `authenticated-${suffix}@example.test`
    const attackerEmail = `attacker-${suffix}@example.test`
    const externalId = `email_view_security_${suffix}`
    const sentMessages = []
    let authenticatedUserId = ''
    let attackerUserId = ''

    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `smtp-email-view-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setHappyPathImapClientFactory()

    try {
      const authenticatedInsert = await db.run(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES (?, ?, 'test-hash', 'Usuario autenticado', 'admin', 1)`,
        [authenticatedUsername, authenticatedEmail]
      )
      authenticatedUserId = String(authenticatedInsert.lastID || '')
      const attackerInsert = await db.run(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES (?, ?, 'test-hash', 'Usuario atacante', 'admin', 1)`,
        [attackerUsername, attackerEmail]
      )
      attackerUserId = String(attackerInsert.lastID || '')
      if (!authenticatedUserId || !attackerUserId) {
        const users = await db.all(
          'SELECT id, username FROM users WHERE username IN (?, ?)',
          [authenticatedUsername, attackerUsername]
        )
        authenticatedUserId ||= String(users.find(user => user.username === authenticatedUsername)?.id || '')
        attackerUserId ||= String(users.find(user => user.username === attackerUsername)?.id || '')
      }

      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo'
      })

      let responseStatus = 200
      let responsePayload = null
      const response = {
        status(code) {
          responseStatus = code
          return this
        },
        json(payload) {
          responsePayload = payload
          return this
        }
      }
      await sendEmailView({
        user: { userId: authenticatedUserId },
        body: {
          to: `recipient-${suffix}@example.test`,
          subject: 'Asesor: {{user.email}}',
          text: 'Tu asesor es {{user.email}}',
          html: '<p>Tu asesor es {{user.email}}</p>',
          externalId,
          includeSignature: false,
          userId: attackerUserId,
          variablesResolved: true,
          extraVariables: {
            'user.email': 'spoofed-from-body@example.test'
          }
        },
        headers: { host: 'app.ristak.test' },
        protocol: 'https'
      }, response)

      assert.equal(responseStatus, 200)
      assert.equal(responsePayload?.success, true)
      assert.equal(sentMessages.length, 2)
      const outgoing = sentMessages[1]
      assert.equal(outgoing.subject, `Asesor: ${authenticatedEmail}`)
      assert.equal(outgoing.text, `Tu asesor es ${authenticatedEmail}`)
      assert.equal(outgoing.html, `<p>Tu asesor es ${authenticatedEmail}</p>`)
      assert.equal(JSON.stringify(outgoing).includes(attackerEmail), false)
      assert.equal(JSON.stringify(outgoing).includes('spoofed-from-body@example.test'), false)
      assert.equal(JSON.stringify(outgoing).includes('{{'), false)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      setEmailImapClientFactoryForTest(null)
      await db.run('DELETE FROM email_messages WHERE id = ?', [externalId]).catch(() => undefined)
      await db.run(
        'DELETE FROM users WHERE username IN (?, ?)',
        [authenticatedUsername, attackerUsername]
      ).catch(() => undefined)
    }
  })
})
