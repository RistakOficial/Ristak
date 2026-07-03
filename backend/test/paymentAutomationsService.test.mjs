import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  ensureDefaultPaymentMessageTemplates
} from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  connectEmail,
  setEmailMxResolverForTest,
  setEmailTransportFactoryForTest
} from '../src/services/emailService.js'
import {
  processDuePaymentAutomations,
  sendPaymentAutomationMessage
} from '../src/services/paymentAutomationsService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'
const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'
const PUBLIC_BASE_URL = 'https://pagos.example.test'

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body)
  }
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

async function withYCloudCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    PAYMENT_SETTINGS_CONFIG_KEY,
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    keys.lastError
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_payment_automation_secret'))
    await setAppConfig(keys.senderPhone, '+526561234567')
    await setAppConfig(keys.phoneNumberId, 'phone_payment_automations_test')
    await setAppConfig(keys.wabaId, 'waba_payment_automations_test')
    await setAppConfig(keys.provider, 'ycloud')
    await setAppConfig(keys.lastError, '')

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      if (path === '/whatsapp/messages' && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          id: `ycloud_payment_auto_${captures.length}`,
          from: body.from,
          to: body.to,
          type: body.type,
          status: 'sent',
          [body.type]: body[body.type]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      await ensureDefaultPaymentMessageTemplates({ publicBaseUrl: PUBLIC_BASE_URL })
      await upsertApprovedTemplate('recordatorio_pago_pendiente')
      await upsertApprovedTemplate('comprobante_pago_recibido')
      await upsertApprovedTemplate('pago_fallido_reintento')
      return await callback(captures)
    } finally {
      setYCloudFetchForTest(null)
    }
  })
}

async function withEmailCapture(callback) {
  await initializeMasterKey()
  const configKeys = [
    PAYMENT_SETTINGS_CONFIG_KEY,
    EMAIL_CONFIG_KEY,
    EMAIL_PASSWORD_KEY,
    EMAIL_SIGNATURE_CONFIG_KEY
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        captures.push(message)
        return {
          messageId: `smtp-payment-auto-${captures.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))

    try {
      await connectEmail({
        fromEmail: 'pagos@ristak.test',
        fromName: 'Ristak Pagos',
        password: 'smtp-payment-secret'
      })
      captures.length = 0
      return await callback(captures)
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
    }
  })
}

async function withAccountTimezoneForTest(timezone, callback) {
  return snapshotAppConfig([ACCOUNT_TIMEZONE_CONFIG_KEY], async () => {
    await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
    invalidateTimezoneCache()

    try {
      return await callback()
    } finally {
      invalidateTimezoneCache()
    }
  })
}

async function upsertApprovedTemplate(name) {
  const components = [
    { type: 'BODY', text: 'Hola {{1}}, pago {{2}} por {{3}}.' },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Abrir', url: `${PUBLIC_BASE_URL}/pay/{{1}}` }]
    }
  ]

  await db.run(`
    INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, category, status,
      components_json, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, 'es_MX', 'UTILITY', 'APPROVED', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(waba_id, name, language) DO UPDATE SET
      status = 'APPROVED',
      components_json = excluded.components_json,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    `wa_tpl_${name}`,
    `official_${name}`,
    'waba_payment_automations_test',
    name,
    JSON.stringify(components),
    JSON.stringify({ name, status: 'APPROVED' })
  ])
}

async function createPaymentFixture({
  status = 'pending',
  dueDate = null,
  updatedAt = null,
  suffix = randomUUID().slice(0, 8)
} = {}) {
  const contactId = `contact_payment_auto_${suffix}`
  const paymentId = `payment_auto_${suffix}`
  const publicPaymentId = `pay_auto_${suffix}`
  const phoneDigits = String([...String(suffix)].reduce((sum, char) => sum + char.charCodeAt(0), 0))
    .padEnd(8, '0')
    .slice(0, 8)

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, created_at, updated_at
    ) VALUES (?, ?, ?, 'Maria Lopez', 'Maria', 'Lopez', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    contactId,
    `+52155${phoneDigits}`,
    `${contactId}@example.test`
  ])

  await db.run(`
    INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_provider,
      reference, title, description, public_payment_id, payment_url, due_date,
      date, created_at, updated_at
    ) VALUES (?, ?, 1499, 'MXN', ?, 'card', 'stripe', 'REC-1048', 'Plan mensual',
      'Plan mensual', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `, [
    paymentId,
    contactId,
    status,
    publicPaymentId,
    `${PUBLIC_BASE_URL}/pay/${publicPaymentId}`,
    dueDate,
    updatedAt || new Date().toISOString(),
    updatedAt || new Date().toISOString()
  ])

  return { contactId, paymentId }
}

async function cleanupFixtures(ids = []) {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(', ')
  await db.run(`DELETE FROM payment_automation_dispatches WHERE payment_id IN (${placeholders})`, ids)
  await db.run(`DELETE FROM payments WHERE id IN (${placeholders})`, ids)
  const contactIds = ids.map((id) => id.replace('payment_auto_', 'contact_payment_auto_'))
  await db.run(`DELETE FROM contacts WHERE id IN (${placeholders})`, contactIds)
}

test('envia comprobante de pago por WhatsApp solo cuando el switch esta activo', async () => {
  await withYCloudCapture(async (captures) => {
    const sentFixture = await createPaymentFixture({ status: 'paid', suffix: 'receipt1' })
    const disabledFixture = await createPaymentFixture({ status: 'paid', suffix: 'receipt2' })

    try {
      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
        automations: {
          receiptDeliveryEnabled: true,
          receiptDeliveryChannel: 'whatsapp',
          receiptTemplateName: 'comprobante_pago_recibido',
          receiptTemplateLanguage: 'es_MX'
        }
      })

      const sent = await sendPaymentAutomationMessage('receipt', sentFixture.paymentId)
      assert.equal(sent.sent, true)
      assert.equal(captures.length, 1)
      assert.equal(captures[0].template.name, 'comprobante_pago_recibido')
      assert.equal(captures[0].externalId, `payment:receipt:${sentFixture.paymentId}`)

      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
        automations: {
          receiptDeliveryEnabled: false,
          receiptDeliveryChannel: 'whatsapp'
        }
      })

      const skipped = await sendPaymentAutomationMessage('receipt', disabledFixture.paymentId)
      assert.equal(skipped.sent, false)
      assert.equal(skipped.reason, 'disabled')
      assert.equal(captures.length, 1)
    } finally {
      await cleanupFixtures([sentFixture.paymentId, disabledFixture.paymentId])
    }
  })
})

test('envia comprobante de pago por correo con boton de PDF descargable', async () => {
  await withEmailCapture(async (captures) => {
    const fixture = await createPaymentFixture({ status: 'paid', suffix: 'emailreceipt1' })

    try {
      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
        receipt: {
          title: 'Comprobante de pago',
          intro: 'Tu pago fue recibido correctamente.',
          businessName: 'Clinica Demo',
          showTerms: true,
          terms: 'Conserva este comprobante para cualquier aclaracion.'
        },
        automations: {
          receiptDeliveryEnabled: true,
          receiptDeliveryChannel: 'email',
          afterPaymentMessage: 'Gracias, recibimos tu pago. Te compartimos tu comprobante.'
        }
      })

      const result = await sendPaymentAutomationMessage('receipt', fixture.paymentId)
      assert.equal(result.sent, true)
      assert.deepEqual(result.channels, ['email'])
      assert.equal(captures.length, 1)
      assert.equal(captures[0].to, `${fixture.contactId}@example.test`)
      assert.equal(captures[0].subject, 'Comprobante de pago - Plan mensual')
      assert.match(captures[0].html, /Descargar comprobante PDF/)
      assert.match(captures[0].html, new RegExp(`${PUBLIC_BASE_URL}/pay/pay_auto_emailreceipt1\\?receipt=1`))
      assert.match(captures[0].text, /Descargar comprobante PDF:/)

      const dispatch = await db.get(
        'SELECT channel, status FROM payment_automation_dispatches WHERE payment_id = ? AND automation_type = ?',
        [fixture.paymentId, 'receipt']
      )
      assert.equal(dispatch.channel, 'email')
      assert.equal(dispatch.status, 'sent')

      const storedEmail = await db.get(
        'SELECT status, subject, html_body FROM email_messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1',
        [fixture.contactId]
      )
      assert.equal(storedEmail.status, 'sent')
      assert.equal(storedEmail.subject, 'Comprobante de pago - Plan mensual')
      assert.match(storedEmail.html_body, /Descargar comprobante PDF/)
    } finally {
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [fixture.contactId])
      await cleanupFixtures([fixture.paymentId])
    }
  })
})

test('canal ambos envia WhatsApp API y correo sin pisar despachos', async () => {
  await withYCloudCapture(async (whatsappCaptures) => {
    await withEmailCapture(async (emailCaptures) => {
      const fixture = await createPaymentFixture({ status: 'paid', suffix: 'bothreceipt1' })

      try {
        await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
          automations: {
            receiptDeliveryEnabled: true,
            receiptDeliveryChannel: 'both',
            receiptTemplateName: 'comprobante_pago_recibido',
            receiptTemplateLanguage: 'es_MX'
          }
        })

        const result = await sendPaymentAutomationMessage('receipt', fixture.paymentId)
        assert.equal(result.sent, true)
        assert.deepEqual(result.channels.sort(), ['email', 'whatsapp'])
        assert.equal(whatsappCaptures.length, 1)
        assert.equal(emailCaptures.length, 1)

        const dispatches = await db.all(
          'SELECT channel, status FROM payment_automation_dispatches WHERE payment_id = ? AND automation_type = ? ORDER BY channel',
          [fixture.paymentId, 'receipt']
        )
        assert.deepEqual(dispatches.map((dispatch) => dispatch.channel), ['email', 'whatsapp'])
        assert.deepEqual(dispatches.map((dispatch) => dispatch.status), ['sent', 'sent'])
      } finally {
        await db.run('DELETE FROM email_messages WHERE contact_id = ?', [fixture.contactId])
        await cleanupFixtures([fixture.paymentId])
      }
    })
  })
})

test('canal ambos respeta despacho legacy de WhatsApp y solo envia correo faltante', async () => {
  await withYCloudCapture(async (whatsappCaptures) => {
    await withEmailCapture(async (emailCaptures) => {
      const fixture = await createPaymentFixture({ status: 'paid', suffix: 'legacysent1' })
      const legacyDispatchId = `payment_auto_receipt_${fixture.paymentId}`

      try {
        await db.run(`
          INSERT INTO payment_automation_dispatches (
            id, payment_id, automation_type, channel, status, template_name, updated_at
          ) VALUES (?, ?, 'receipt', 'whatsapp', 'sent', 'comprobante_pago_recibido', CURRENT_TIMESTAMP)
        `, [legacyDispatchId, fixture.paymentId])

        await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
          automations: {
            receiptDeliveryEnabled: true,
            receiptDeliveryChannel: 'both',
            receiptTemplateName: 'comprobante_pago_recibido',
            receiptTemplateLanguage: 'es_MX'
          }
        })

        const result = await sendPaymentAutomationMessage('receipt', fixture.paymentId)
        assert.equal(result.sent, true)
        assert.deepEqual(result.channels, ['email'])
        assert.equal(whatsappCaptures.length, 0)
        assert.equal(emailCaptures.length, 1)

        const dispatches = await db.all(
          'SELECT id, channel, status FROM payment_automation_dispatches WHERE payment_id = ? AND automation_type = ? ORDER BY id',
          [fixture.paymentId, 'receipt']
        )
        assert.equal(dispatches.length, 2)
        assert.ok(dispatches.some((dispatch) => dispatch.id === legacyDispatchId && dispatch.channel === 'whatsapp' && dispatch.status === 'sent'))
        assert.ok(dispatches.some((dispatch) => dispatch.channel === 'email' && dispatch.status === 'sent'))
      } finally {
        await db.run('DELETE FROM email_messages WHERE contact_id = ?', [fixture.contactId])
        await cleanupFixtures([fixture.paymentId])
      }
    })
  })
})

test('cola de automatizaciones respeta recordatorios y cobros fallidos encendidos y apagados', async () => {
  await withYCloudCapture(async (captures) => {
    const now = new Date('2026-06-20T18:00:00.000Z')
    const reminderFixture = await createPaymentFixture({
      status: 'sent',
      dueDate: '2026-06-21T12:00:00.000Z',
      suffix: 'remind1'
    })
    const failedFixture = await createPaymentFixture({
      status: 'failed',
      updatedAt: '2026-06-20T10:00:00.000Z',
      suffix: 'failed1'
    })
    const reminderOffFixture = await createPaymentFixture({
      status: 'sent',
      dueDate: '2026-06-21T12:00:00.000Z',
      suffix: 'remind2'
    })
    const failedOffFixture = await createPaymentFixture({
      status: 'failed',
      updatedAt: '2026-06-20T10:00:00.000Z',
      suffix: 'failed2'
    })

    try {
      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
        automations: {
          remindersEnabled: true,
          reminderDaysBefore: 3,
          reminderChannel: 'whatsapp',
          reminderTemplateName: 'recordatorio_pago_pendiente',
          reminderTemplateLanguage: 'es_MX',
          failedPaymentEnabled: true,
          failedPaymentChannel: 'whatsapp',
          failedPaymentDelayHours: 2,
          failedPaymentTemplateName: 'pago_fallido_reintento',
          failedPaymentTemplateLanguage: 'es_MX'
        }
      })

      const fixtureIds = [reminderFixture.paymentId, failedFixture.paymentId]
      const results = await processDuePaymentAutomations({ now, limit: 10, paymentIds: fixtureIds })
      assert.equal(results.filter((result) => result.sent).length, 2)
      assert.deepEqual(
        captures.map((capture) => capture.template.name).sort(),
        ['pago_fallido_reintento', 'recordatorio_pago_pendiente']
      )

      await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
        automations: {
          remindersEnabled: false,
          reminderChannel: 'whatsapp',
          failedPaymentEnabled: false,
          failedPaymentChannel: 'whatsapp'
        }
      })

      await processDuePaymentAutomations({
        now,
        limit: 10,
        paymentIds: [reminderOffFixture.paymentId, failedOffFixture.paymentId]
      })
      assert.equal(captures.length, 2)
    } finally {
      await cleanupFixtures([
        reminderFixture.paymentId,
        failedFixture.paymentId,
        reminderOffFixture.paymentId,
        failedOffFixture.paymentId
      ])
    }
  })
})

test('recordatorios de pago usan el dia del negocio, no el dia UTC del servidor', async () => {
  await withYCloudCapture(async (captures) => {
    await withAccountTimezoneForTest('America/Los_Angeles', async () => {
      const now = new Date('2026-06-30T06:30:00.000Z') // 29 jun 2026 23:30 en Los Angeles
      const reminderFixture = await createPaymentFixture({
        status: 'sent',
        dueDate: '2026-06-29T19:00:00.000Z',
        suffix: 'tzremind'
      })

      try {
        await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
          automations: {
            remindersEnabled: true,
            reminderDaysBefore: 1,
            reminderChannel: 'whatsapp',
            reminderTemplateName: 'recordatorio_pago_pendiente',
            reminderTemplateLanguage: 'es_MX',
            failedPaymentEnabled: false,
            failedPaymentChannel: 'whatsapp'
          }
        })

        const results = await processDuePaymentAutomations({
          now,
          limit: 10,
          paymentIds: [reminderFixture.paymentId]
        })

        assert.equal(results.filter((result) => result.sent).length, 1)
        assert.equal(captures.length, 1)
        assert.equal(captures[0].template.name, 'recordatorio_pago_pendiente')
      } finally {
        await cleanupFixtures([reminderFixture.paymentId])
      }
    })
  })
})

test('consulta recordatorios sin aplicar TRIM a due_date timestamp', async () => {
  await snapshotAppConfig([PAYMENT_SETTINGS_CONFIG_KEY], async () => {
    await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, {
      automations: {
        remindersEnabled: true,
        reminderDaysBefore: 3,
        reminderChannel: 'whatsapp',
        failedPaymentEnabled: false,
        failedPaymentChannel: 'whatsapp'
      }
    })

    const originalAll = db.all
    const queries = []
    db.all = async function patchedAll(sql, ...args) {
      queries.push(String(sql || ''))
      if (String(sql || '').includes('FROM payments')) return []
      return originalAll.call(this, sql, ...args)
    }

    try {
      await processDuePaymentAutomations({
        now: new Date('2026-06-20T18:00:00.000Z'),
        limit: 10,
        paymentIds: ['payment_auto_pg_timestamp']
      })
    } finally {
      db.all = originalAll
    }

    const reminderQuery = queries.find((query) => query.includes('FROM payments'))
    assert.ok(reminderQuery)
    assert.match(reminderQuery, /due_date IS NOT NULL/)
    assert.doesNotMatch(reminderQuery, /TRIM\s*\(\s*due_date\s*\)/i)
  })
})
