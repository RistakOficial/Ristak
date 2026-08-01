import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY } from '../src/services/accountBusinessProfileService.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import { createVariableField } from '../src/services/variableFieldsService.js'
import { readTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'
import {
  renderTemplateVariables,
  renderTemplateVariablesInValue
} from '../src/services/templateVariablesService.js'
import { renderCalendarAppointmentTemplates } from '../src/services/calendarAppointmentTemplateService.js'

test('renderTemplateVariables solo resuelve usuario con contexto explicito y toma el negocio del perfil de cuenta', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const usernames = [
    `variable_user_first_${suffix}`,
    `variable_user_selected_${suffix}`
  ]
  const emails = [
    `first-${suffix}@example.test`,
    `selected-${suffix}@example.test`
  ]
  const previousProfile = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY]
  )
  let selectedUserId = ''

  try {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY])
    await setAppConfig(ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY, {
      name: `Negocio desde perfil ${suffix}`
    })

    await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, 'test-hash', 'Primer usuario', 'admin', 1)`,
      [usernames[0], emails[0]]
    )
    const selectedInsert = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, 'test-hash', 'Usuario seleccionado', 'admin', 1)`,
      [usernames[1], emails[1]]
    )
    selectedUserId = String(selectedInsert.lastID || '')
    if (!selectedUserId) {
      const selectedUser = await db.get('SELECT id FROM users WHERE username = ?', [usernames[1]])
      selectedUserId = String(selectedUser?.id || '')
    }

    const withoutUserContext = await renderTemplateVariables(
      '{{user.email}}|{{account.business_name}}'
    )
    assert.equal(withoutUserContext, `|Negocio desde perfil ${suffix}`)
    assert.equal(withoutUserContext.includes(emails[0]), false)

    const withExplicitUser = await renderTemplateVariables(
      '{{user.email}}|{{account.business_name}}',
      { userId: selectedUserId }
    )
    assert.equal(withExplicitUser, `${emails[1]}|Negocio desde perfil ${suffix}`)
  } finally {
    await db.run(
      'DELETE FROM users WHERE username IN (?, ?)',
      usernames
    ).catch(() => undefined)
    await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY])
      .catch(() => undefined)
    if (previousProfile) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET
           config_value = excluded.config_value,
           updated_at = CURRENT_TIMESTAMP`,
        [ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY, previousProfile.config_value]
      ).catch(() => undefined)
    }
  }
})

test('renderTemplateVariables resuelve contacto, personalizados, variables y enlaces de disparo', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_variables_${suffix}`
  const phone = `+5255${suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '7')}`
  let variableField
  let triggerLink

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        phone,
        `ana-${suffix}@example.test`,
        'Ana Prueba',
        'Ana',
        'Prueba',
        JSON.stringify([{ fieldKey: 'plan', label: 'Plan', value: 'Premium' }])
      ]
    )

    variableField = await createVariableField({
      label: 'Nombre del negocio',
      fieldKey: `negocio_${suffix.replace(/-/g, '_')}`,
      value: 'Ristak Demo'
    })

    triggerLink = await createTriggerLink(
      {
        name: `Promo ${suffix}`,
        destinationUrl: 'example.com/promo'
      },
      { baseUrl: 'https://app.ristak.test' }
    )

    const output = await renderTemplateVariables(
      `Hola {{first_name}}, plan {{custom.plan}}, negocio {{${variableField.parameter.slice(2, -2)}}}, link {{trigger_link.${triggerLink.publicId}}}, nada "{{no_existe}}"`,
      {
        contactId,
        publicBaseUrl: 'https://app.ristak.test'
      }
    )

    assert.match(output, /Hola Ana, plan Premium, negocio Ristak Demo/)
    const renderedUrl = output.match(/https:\/\/app\.ristak\.test\/(pce1_[A-Za-z0-9_-]+)/)?.[0]
    assert.ok(renderedUrl, output)
    assert.equal(new URL(renderedUrl).search, '')
    assert.ok(!renderedUrl.includes(contactId))
    assert.ok(!renderedUrl.includes(phone))
    assert.ok(!renderedUrl.includes(`ana-${suffix}@example.test`))
    assert.deepEqual(
      await readTriggerLinkRecipientToken(new URL(renderedUrl).pathname.slice(1)),
      { publicId: triggerLink.publicId, contactId }
    )
    assert.match(output, /nada ""/)
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    if (variableField?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [variableField.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('renderTemplateVariables conserva placeholders numericos de plantillas oficiales', async () => {
  const output = await renderTemplateVariables(
    'Valores oficiales: {{1}}, {{ 2 }} y {{0003}}; CRM faltante: {{contact.no_existe}}'
  )

  assert.equal(
    output,
    'Valores oficiales: {{1}}, {{ 2 }} y {{0003}}; CRM faltante: '
  )
})

test('renderTemplateVariables hace una sola expansion y no interpreta tokens dentro del valor resuelto', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  let outerField
  let innerField

  try {
    innerField = await createVariableField({
      label: `Valor interno ${suffix}`,
      fieldKey: `atomic_inner_${suffix}`,
      value: 'valor-final'
    })
    outerField = await createVariableField({
      label: `Valor externo ${suffix}`,
      fieldKey: `atomic_outer_${suffix}`,
      value: `antes ${innerField.parameter} despues`
    })

    const output = await renderTemplateVariables(`Resultado: ${outerField.parameter}`)

    assert.equal(output, `Resultado: antes ${innerField.parameter} despues`)
    assert.doesNotMatch(output, /valor-final/)
  } finally {
    if (outerField?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [outerField.id]).catch(() => undefined)
    }
    if (innerField?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [innerField.id]).catch(() => undefined)
    }
  }
})

test('renderTemplateVariablesInValue clona y recorre estructuras sin perder 0, false ni arrays', async () => {
  const source = {
    zero: '{{zeroValue}}',
    disabled: '{{falseValue}}',
    arrayValue: '{{arrayValue}}',
    nested: [
      0,
      false,
      '{{external.keep_me}}',
      {
        missingContact: '{{contact.no_existe}}',
        missingCustom: '{{custom.no_existe}}',
        missingVariable: '{{variable.no_existe}}'
      }
    ]
  }

  const rendered = await renderTemplateVariablesInValue(
    source,
    {
      extraVariables: {
        zeroValue: 0,
        falseValue: false,
        arrayValue: ['uno', 0, false, 'dos']
      }
    },
    { preserveUnknown: true }
  )

  assert.deepEqual(rendered, {
    zero: '0',
    disabled: 'false',
    arrayValue: 'uno, 0, false, dos',
    nested: [
      0,
      false,
      '{{external.keep_me}}',
      {
        missingContact: '',
        missingCustom: '',
        missingVariable: ''
      }
    ]
  })
  assert.notStrictEqual(rendered, source)
  assert.notStrictEqual(rendered.nested, source.nested)
  assert.equal(source.zero, '{{zeroValue}}')
  assert.equal(source.nested[2], '{{external.keep_me}}')
})

test('renderTemplateVariables acepta aliases camelCase de contacto', async () => {
  const output = await renderTemplateVariables(
    [
      '{{contact.firstName}}',
      '{{contact.lastName}}',
      '{{contact.fullName}}',
      '{{contact.companyName}}',
      '{{contact.postalCode}}',
      '{{contact.dateOfBirth}}'
    ].join('|'),
    {
      contact: {
        id: `rstk_contact_camel_${randomUUID()}`,
        firstName: 'Ana',
        lastName: 'Prueba',
        companyName: 'Ristak Labs',
        postalCode: '32500',
        dateOfBirth: '1990-04-03'
      }
    }
  )

  assert.equal(output, 'Ana|Prueba|Ana Prueba|Ristak Labs|32500|1990-04-03')
})

test('renderCalendarAppointmentTemplates arma titulo y notas de cita con parametros', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_calendar_tpl_${suffix}`
  let variableField

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, last_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        '+525555551234',
        `cita-${suffix}@example.test`,
        'Luis Agenda',
        'Luis',
        'Agenda'
      ]
    )

    variableField = await createVariableField({
      label: 'Nombre del negocio',
      fieldKey: `negocio_cal_${suffix.replace(/-/g, '_')}`,
      value: 'Ristak Consultores'
    })

    const rendered = await renderCalendarAppointmentTemplates({
      calendar: {
        id: 'rstk_cal_demo',
        name: 'Consultor Digital',
        eventTitle: 'Cita con {{contact.full_name}}',
        notes: 'Cliente: {{contact.first_name}}\nNegocio: {{variable.' + variableField.fieldKey + '}}\nNotas: {{appointment.notes}}'
      },
      appointmentData: {
        contactId,
        calendarId: 'rstk_cal_demo',
        startTime: '2026-06-20T16:30:00.000Z',
        endTime: '2026-06-20T17:30:00.000Z',
        appointmentStatus: 'confirmed',
        notes: 'Quiere revisar calendario'
      },
      titleTemplate: 'Cita con {{contact.full_name}}',
      notesTemplate: 'Cliente: {{contact.first_name}}\nNegocio: {{variable.' + variableField.fieldKey + '}}\nNotas: {{appointment.notes}}'
    })

    assert.equal(rendered.title, 'Cita con Luis Agenda')
    assert.match(rendered.notes, /Cliente: Luis/)
    assert.match(rendered.notes, /Negocio: Ristak Consultores/)
    assert.match(rendered.notes, /Notas: Quiere revisar calendario/)
  } finally {
    if (variableField?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [variableField.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
