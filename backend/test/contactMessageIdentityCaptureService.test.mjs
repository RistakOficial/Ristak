import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import {
  captureContactIdentityFromMessage,
  extractContactIdentityCandidatesFromText,
  extractEmailCandidatesFromText,
  extractPhoneCandidatesFromText
} from '../src/services/contactMessageIdentityCaptureService.js'
import { ACCOUNT_DIAL_CODE_CONFIG_KEY } from '../src/utils/accountLocale.js'

async function withMexicoDialCode(callback) {
  const previous = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    [ACCOUNT_DIAL_CODE_CONFIG_KEY]
  ).catch(() => null)

  await setAppConfig(ACCOUNT_DIAL_CODE_CONFIG_KEY, '52')
  try {
    return await callback()
  } finally {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_DIAL_CODE_CONFIG_KEY]).catch(() => undefined)
    if (previous) {
      await setAppConfig(ACCOUNT_DIAL_CODE_CONFIG_KEY, previous.config_value)
    }
  }
}

async function cleanupContacts(...contactIds) {
  for (const contactId of contactIds.filter(Boolean)) {
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
}

function contactId(suffix = '') {
  return `test_capture_${randomUUID().replace(/-/g, '').slice(0, 18)}${suffix}`
}

test('extracts common Mexico phone formats with account dial code', () => {
  const variants = [
    '6567426612',
    '656 742 6612',
    '656-742-6612',
    '(656) 742 6612',
    '(656) 742-6612',
    '+52 656 742 6612',
    '52 656 742 6612',
    '521 656 742 6612'
  ]

  for (const variant of variants) {
    assert.deepEqual(
      extractPhoneCandidatesFromText(`Mi cel es ${variant}`, { dialCode: '52' }),
      ['+526567426612'],
      variant
    )
  }
})

test('extracts email candidates and trims trailing punctuation', () => {
  assert.deepEqual(
    extractEmailCandidatesFromText('Escribeme a Cliente.Test+demo@Example.COM, gracias.'),
    ['cliente.test+demo@example.com']
  )
})

test('does not extract phone candidates when phone capture is disabled', () => {
  assert.deepEqual(
    extractContactIdentityCandidatesFromText('Mi correo es demo@example.com y mi cel 656-742-6612', {
      allowEmail: true,
      allowPhone: false,
      dialCode: '52'
    }),
    {
      emails: ['demo@example.com'],
      phones: []
    }
  )
})

test('ignores short numeric fragments and URL noise', () => {
  assert.deepEqual(
    extractPhoneCandidatesFromText('La cita es 12-07-2026 y el link https://site.test/promo/6567426612', { dialCode: '52' }),
    []
  )
})

test('fills missing contact email and phone from an inbound social message', async () => {
  await withMexicoDialCode(async () => {
    const id = contactId()
    try {
      await db.run('INSERT INTO contacts (id, full_name, source) VALUES (?, ?, ?)', [id, 'Cliente Captura', 'Messenger'])

      const result = await captureContactIdentityFromMessage({
        contactId: id,
        text: 'Mi correo es Cliente@Test.COM y mi cel es (656) 742-6612',
        source: 'test_meta_message',
        allowEmail: true,
        allowPhone: true
      })

      assert.deepEqual(result.updatedFields.sort(), ['email', 'phone'])

      const contact = await db.get('SELECT email, phone FROM contacts WHERE id = ?', [id])
      assert.equal(contact.email, 'cliente@test.com')
      assert.equal(contact.phone, '+526567426612')

      const phoneRow = await db.get('SELECT phone, source, is_primary FROM contact_phone_numbers WHERE contact_id = ?', [id])
      assert.equal(phoneRow.phone, '+526567426612')
      assert.equal(phoneRow.source, 'test_meta_message')
      assert.equal(Number(phoneRow.is_primary), 1)
    } finally {
      await cleanupContacts(id)
    }
  })
})

test('does not replace existing contact phone or email', async () => {
  await withMexicoDialCode(async () => {
    const id = contactId()
    try {
      await db.run(
        'INSERT INTO contacts (id, full_name, email, phone, source) VALUES (?, ?, ?, ?, ?)',
        [id, 'Cliente Completo', 'actual@test.com', '+525551112222', 'Messenger']
      )

      const result = await captureContactIdentityFromMessage({
        contactId: id,
        text: 'Nuevo correo nuevo@test.com y tel 6567426612',
        source: 'test_meta_message',
        allowEmail: true,
        allowPhone: true
      })

      assert.deepEqual(result.updatedFields, [])

      const contact = await db.get('SELECT email, phone FROM contacts WHERE id = ?', [id])
      assert.equal(contact.email, 'actual@test.com')
      assert.equal(contact.phone, '+525551112222')
    } finally {
      await cleanupContacts(id)
    }
  })
})

test('does not steal detected identity from another contact', async () => {
  await withMexicoDialCode(async () => {
    const ownerId = contactId('_owner')
    const targetId = contactId('_target')
    try {
      await db.run(
        'INSERT INTO contacts (id, full_name, email, phone, source) VALUES (?, ?, ?, ?, ?)',
        [ownerId, 'Duenio Original', 'ocupado@test.com', '+526567426612', 'manual']
      )
      await db.run('INSERT INTO contacts (id, full_name, source) VALUES (?, ?, ?)', [targetId, 'Cliente Nuevo', 'Messenger'])

      const result = await captureContactIdentityFromMessage({
        contactId: targetId,
        text: 'Correo ocupado@test.com y cel 656-742-6612',
        source: 'test_meta_message',
        allowEmail: true,
        allowPhone: true
      })

      assert.deepEqual(result.updatedFields, [])

      const target = await db.get('SELECT email, phone FROM contacts WHERE id = ?', [targetId])
      assert.equal(target.email, null)
      assert.equal(target.phone, null)
    } finally {
      await cleanupContacts(ownerId, targetId)
    }
  })
})
