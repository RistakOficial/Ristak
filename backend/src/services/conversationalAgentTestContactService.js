import { db } from '../config/database.js'
import { generateContactId } from './contactIdentityService.js'

export const CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL = 'test@aiagent.com'
export const CONVERSATIONAL_AGENT_TEST_CONTACT_NAME = 'Contacto de prueba'
export const CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE = 'conversational_agent_test'

const TEST_CONTACT_COLUMNS = `
  id, full_name, first_name, last_name, phone, email, source, deleted_at
`

async function findConversationalAgentTestContact() {
  return db.get(
    `SELECT ${TEST_CONTACT_COLUMNS}
     FROM contacts
     WHERE LOWER(TRIM(email)) = ?
     ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, created_at ASC
     LIMIT 1`,
    [CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL]
  )
}

async function restoreConversationalAgentTestContact(contact) {
  if (!contact?.id || !contact.deleted_at) return contact

  await db.run(
    `UPDATE contacts
     SET deleted_at = NULL,
         full_name = COALESCE(NULLIF(full_name, ''), ?),
         first_name = COALESCE(NULLIF(first_name, ''), ?),
         source = COALESCE(NULLIF(source, ''), ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      CONVERSATIONAL_AGENT_TEST_CONTACT_NAME,
      CONVERSATIONAL_AGENT_TEST_CONTACT_NAME,
      CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE,
      contact.id
    ]
  )

  return db.get(
    `SELECT ${TEST_CONTACT_COLUMNS}
     FROM contacts
     WHERE id = ? AND deleted_at IS NULL`,
    [contact.id]
  )
}

/**
 * Devuelve la identidad técnica estable del tester.
 *
 * La fila sólo se materializa cuando una capacidad de Modo test necesita
 * registrar efectos reales aislados. Las pruebas puramente simuladas conservan
 * la misma identidad como contacto virtual y no escriben en la base.
 */
export async function resolveConversationalAgentTestContact() {
  const existing = await findConversationalAgentTestContact()
  if (existing?.id) return restoreConversationalAgentTestContact(existing)

  const contactId = generateContactId()
  try {
    await db.run(
      `INSERT INTO contacts (
         id, email, full_name, first_name, source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        contactId,
        CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL,
        CONVERSATIONAL_AGENT_TEST_CONTACT_NAME,
        CONVERSATIONAL_AGENT_TEST_CONTACT_NAME,
        CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE
      ]
    )
  } catch (error) {
    // Dos instancias pueden intentar materializar el contacto al mismo tiempo.
    // La restricción única decide el ganador; la perdedora reutiliza esa fila.
    const concurrent = await findConversationalAgentTestContact()
    if (concurrent?.id) return restoreConversationalAgentTestContact(concurrent)
    throw error
  }

  return db.get(
    `SELECT ${TEST_CONTACT_COLUMNS}
     FROM contacts
     WHERE id = ? AND deleted_at IS NULL`,
    [contactId]
  )
}
