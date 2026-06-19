import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig } from '../src/config/database.js'
import { decrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  connectEmail,
  detectEmailProvider,
  setEmailMxResolverForTest,
  setEmailTransportFactoryForTest
} from '../src/services/emailService.js'

const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'

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

      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].to, 'ventas@clinicademo.com')
      assert.match(sentMessages[0].from, /Clínica Demo/)

      const encryptedPassword = await getAppConfig(EMAIL_PASSWORD_KEY)
      assert.notEqual(encryptedPassword, 'app-password-demo')
      assert.equal(decrypt(encryptedPassword), 'app-password-demo')
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
    }
  })
})
