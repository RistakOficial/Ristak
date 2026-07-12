import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { db } from '../src/config/database.js'
import { searchContacts } from '../src/controllers/contactsController.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function runSearch(query) {
  const response = createResponse()
  await searchContacts({ query }, response)
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.equal(response.body?.success, true)
  return response.body.data
}

test('el directorio picker busca identidad y teléfono alterno sin métricas pesadas', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `contact_picker_${suffix}`
  const phoneId = `contact_phone_picker_${suffix}`
  const messageId = `contact_picker_message_${suffix}`
  const profileId = `contact_picker_profile_${suffix}`
  const profilePhotoUrl = `https://images.example.invalid/${suffix}.jpg`
  const alternatePhone = `+5299${suffix.replace(/\D/g, '').padEnd(10, '7').slice(0, 10)}`
  const uniqueName = `Selector Veloz ${suffix.slice(0, 10)}`

  const cleanup = async () => {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [messageId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [profileId]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE id = ?', [phoneId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
  await cleanup()

  try {
    await db.run(
      `INSERT INTO contacts (
        id, full_name, first_name, last_name, email, phone, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        uniqueName,
        'Selector',
        `Veloz ${suffix.slice(0, 10)}`,
        `${suffix}@picker.invalid`,
        '+526561234567',
        'test',
        '2099-09-01T10:00:00.000Z',
        '2099-09-01T10:00:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO contact_phone_numbers (
        id, contact_id, phone, label, is_primary, source, created_at, updated_at
      ) VALUES (?, ?, ?, 'Trabajo', 0, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [phoneId, contactId, alternatePhone]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, direction, message_type, message_text, transport, message_timestamp, created_at
      ) VALUES (?, ?, ?, 'inbound', 'text', 'Hola desde WhatsApp', 'api', ?, ?)`,
      [messageId, contactId, '+526561234567', '2099-09-01T10:03:00.000Z', '2099-09-01T10:03:00.000Z']
    )
    await db.run(
      `INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [profileId, contactId, '+526561234567', uniqueName, profilePhotoUrl]
    )

    const byName = await runSearch({ picker: 'true', q: uniqueName, limit: '60' })
    assert.equal(byName.length, 1)
    assert.equal(byName[0].id, contactId)
    assert.equal(byName[0].name.toLocaleLowerCase('es'), uniqueName.toLocaleLowerCase('es'))
    assert.equal(byName[0].ltv, 0)
    assert.equal(byName[0].purchases, 0)
    assert.equal(byName[0].profilePhotoUrl, profilePhotoUrl)
    assert.equal(byName[0].phones[0].phone, '+526561234567')
    assert.equal(byName[0].phones.some(entry => entry.phone === alternatePhone), true)
    assert.equal(byName[0].lastMessageChannel, 'whatsapp')
    assert.equal(byName[0].lastMessageTransport, 'api')
    assert.equal(byName[0].lastMessageType, 'text')

    const alternateDigits = alternatePhone.replace(/\D/g, '').slice(-8)
    const byAlternatePhone = await runSearch({ picker: 'true', q: alternateDigits })
    assert.equal(byAlternatePhone.some(contact => contact.id === contactId), true)
    assert.equal(byAlternatePhone.find(contact => contact.id === contactId)?.matchedPhone, alternatePhone)

    const nameWithDigits = `Empresa 2468 ${suffix.slice(0, 8)}`
    await db.run('UPDATE contacts SET full_name = ? WHERE id = ?', [nameWithDigits, contactId])
    const byNameWithDigits = await runSearch({ picker: 'true', q: 'Empresa 2468' })
    assert.equal(
      byNameWithDigits.find(contact => contact.id === contactId)?.matchedPhone,
      '',
      'los dígitos de un nombre no deben seleccionar un teléfono alterno como destinatario'
    )

    const recents = await runSearch({ picker: 'true', limit: '1' })
    assert.equal(recents.length, 1)
    assert.equal(recents[0].id, contactId)
  } finally {
    await cleanup()
  }
})

test('el modo picker no vuelve a meter agregados ni calentamiento externo', () => {
  const source = readFileSync(new URL('../src/controllers/contactsController.js', import.meta.url), 'utf8')
  const pickerStart = source.indexOf('if (pickerMode)')
  const legacyStart = source.indexOf('const searchClause = buildContactSearchClause(\'c\', q)', pickerStart)
  assert.ok(pickerStart >= 0 && legacyStart > pickerStart, 'no se encontró la rama ligera del picker')

  const pickerSource = source.slice(pickerStart, legacyStart)
  assert.doesNotMatch(pickerSource, /WITH payment_stats/i)
  assert.doesNotMatch(pickerSource, /warmWhatsAppProfilePicturesForRows\s*\(/)
  assert.doesNotMatch(pickerSource, /attachContactPhoneNumbers\s*\(/)
  assert.doesNotMatch(pickerSource, /FROM appointments/i)
})

test('el directorio limita una búsqueda de dos mil contactos sin inflar el payload', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const idPrefix = `picker_load_${suffix}_`
  // Este caso mide límite y orden del directorio, no ranking telefónico. Un
  // UUID hexadecimal puede contener siete dígitos y convertir accidentalmente
  // el término mixto en coincidencia parcial de teléfono, haciendo que la
  // prueba dependa del UUID aleatorio de esa corrida.
  const alphabeticSuffix = suffix
    .slice(0, 10)
    .replace(/[0-9]/g, digit => String.fromCharCode(103 + Number(digit)))
  const commonTerm = `CargaDirectorio${alphabeticSuffix}`
  const total = 2_000

  const cleanup = () => db.run('DELETE FROM contacts WHERE id LIKE ?', [`${idPrefix}%`])
  await cleanup()

  try {
    await db.exec('BEGIN')
    for (let start = 0; start < total; start += 100) {
      const values = []
      const placeholders = []
      for (let index = start; index < Math.min(start + 100, total); index += 1) {
        const padded = String(index).padStart(4, '0')
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?)')
        values.push(
          `${idPrefix}${padded}`,
          `${commonTerm} ${padded}`,
          `${suffix}.${padded}@load.invalid`,
          `+5255${suffix.replace(/\D/g, '').padEnd(6, '8').slice(0, 6)}${padded}`,
          'load_test',
          '2098-01-01T00:00:00.000Z',
          '2098-01-01T00:00:00.000Z',
          null
        )
      }
      await db.run(
        `INSERT INTO contacts (
          id, full_name, email, phone, source, created_at, updated_at, deleted_at
        ) VALUES ${placeholders.join(', ')}`,
        values
      )
    }
    await db.exec('COMMIT')

    // El servidor recibe un límite abusivo pero conserva el máximo contractual
    // de 100. La prueba fuerza el scan/ranking de 2,000 candidatos sin depender
    // de un umbral de milisegundos frágil para CI.
    const result = await runSearch({ picker: 'true', q: commonTerm, limit: '500' })
    assert.equal(result.length, 100)
    assert.equal(result[0].id, `${idPrefix}1999`)
    assert.equal(result.at(-1).id, `${idPrefix}1900`)
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await cleanup()
  }
})

test('contactId exacto resuelve una fila fuera de recientes sin saltarse ocultos', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const idPrefix = `picker_exact_${suffix}_`
  const targetId = `${idPrefix}target`
  const targetPhoneId = `${idPrefix}phone`
  const alternatePhone = `+52199${String(Date.now()).slice(-7)}`
  const totalRecent = 105

  const cleanup = async () => {
    await db.run('DELETE FROM hidden_contact_filters WHERE filter_text = ?', [targetId]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE id = ?', [targetPhoneId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${idPrefix}%`]).catch(() => undefined)
  }
  await cleanup()

  try {
    await db.run(
      `INSERT INTO contacts (
        id, full_name, email, phone, source, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, 'exact_picker_test', ?, ?, NULL)`,
      [
        targetId,
        `Objetivo exacto ${suffix}`,
        `${suffix}.target@picker.invalid`,
        `+52188${String(Date.now()).slice(-7)}`,
        '2001-01-01T00:00:00.000Z',
        '2001-01-01T00:00:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO contact_phone_numbers (
        id, contact_id, phone, label, is_primary, source, created_at, updated_at
      ) VALUES (?, ?, ?, 'Trabajo', 0, 'exact_picker_test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [targetPhoneId, targetId, alternatePhone]
    )

    await db.exec('BEGIN')
    for (let start = 0; start < totalRecent; start += 35) {
      const placeholders = []
      const values = []
      for (let index = start; index < Math.min(start + 35, totalRecent); index += 1) {
        const padded = String(index).padStart(3, '0')
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, NULL)')
        values.push(
          `${idPrefix}${padded}`,
          `Reciente exacto ${suffix} ${padded}`,
          `${suffix}.${padded}.recent@picker.invalid`,
          `+52277${String(Date.now()).slice(-4)}${padded}`,
          'exact_picker_test',
          '2096-01-01T00:00:00.000Z',
          '2096-01-01T00:00:00.000Z'
        )
      }
      await db.run(
        `INSERT INTO contacts (
          id, full_name, email, phone, source, created_at, updated_at, deleted_at
        ) VALUES ${placeholders.join(', ')}`,
        values
      )
    }
    await db.exec('COMMIT')

    const recents = await runSearch({ picker: 'true', limit: '100' })
    assert.equal(recents.some(contact => contact.id === targetId), false)

    const exact = await runSearch({
      picker: 'true',
      contactId: targetId,
      q: 'consulta que no debe filtrar el id',
      limit: '100'
    })
    assert.equal(exact.length, 1)
    assert.equal(exact[0].id, targetId)
    assert.equal(exact[0].phones.some(phone => phone.phone === alternatePhone), true)

    assert.deepEqual(await runSearch({
      picker: 'true',
      contactId: `${idPrefix}unknown`
    }), [])

    await db.run(
      `INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
       VALUES (?, 'exact', CURRENT_TIMESTAMP)`,
      [targetId]
    )
    assert.deepEqual(await runSearch({ picker: 'true', contactId: targetId }), [])
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await cleanup()
  }
})
