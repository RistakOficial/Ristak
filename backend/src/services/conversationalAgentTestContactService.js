import { createHash } from 'node:crypto'
import { db } from '../config/database.js'

export const CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL = 'test@ristaktests.com'
export const CONVERSATIONAL_AGENT_TEST_CONTACT_NAME = 'Contacto de prueba'
export const CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE = 'conversational_agent_test'
const AUTOMATIC_TEST_CONTACT_PREFIX = 'rstk_contact_bot_test_'

export function isAutomaticConversationalAgentTestContactId(id) {
  return typeof id === 'string' && id.startsWith(AUTOMATIC_TEST_CONTACT_PREFIX) &&
    /^[a-f0-9]{32}$/.test(id.slice(AUTOMATIC_TEST_CONTACT_PREFIX.length))
}

export function isLocalOnlyConversationalTestAppointment(appointment) {
  return (appointment?.isTest === true || Number(appointment?.is_test) === 1) &&
    isAutomaticConversationalAgentTestContactId(appointment.contactId || appointment.contact_id)
}

/**
 * Usa el ID guardado del bot, no su nombre ni el email de una persona, para
 * que dos bots homónimos nunca compartan ficha y un renombre no cree otra.
 * El upsert también resuelve dos pruebas iniciadas al mismo tiempo.
 */
export async function resolveConversationalAgentTestContact(agent) {
  const agentId = String(agent?.id || '').trim()
  if (!agentId) throw new Error('Falta el agente guardado para crear el contacto de prueba.')
  const key = createHash('sha256').update(agentId).digest('hex').slice(0, 32)
  const contactId = `${AUTOMATIC_TEST_CONTACT_PREFIX}${key}`
  const name = `${String(agent.name || '').trim() || 'Asistente'} - Test`
  const email = `bot-${key}@ristak-test.invalid`

  await db.run(
    `INSERT INTO contacts (id, email, full_name, first_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email, phone = NULL, full_name = excluded.full_name,
       first_name = excluded.first_name, last_name = NULL, deleted_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE contacts.source = excluded.source
       AND (contacts.deleted_at IS NOT NULL OR contacts.phone IS NOT NULL OR contacts.last_name IS NOT NULL
            OR COALESCE(contacts.email, '') <> excluded.email
            OR COALESCE(contacts.full_name, '') <> excluded.full_name
            OR COALESCE(contacts.first_name, '') <> excluded.first_name)`,
    [contactId, email, name, name, CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE]
  )

  return db.get(
    `SELECT id, full_name, first_name, last_name, phone, email, source, deleted_at
     FROM contacts WHERE id = ? AND source = ? AND deleted_at IS NULL`,
    [contactId, CONVERSATIONAL_AGENT_TEST_CONTACT_SOURCE]
  )
}
