import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'

const CONTACT_REFERENCE_TABLES = [
  { table: 'payments', column: 'contact_id' },
  { table: 'payment_plans', column: 'contact_id' },
  { table: 'appointments', column: 'contact_id' },
  { table: 'appointment_attendance_signals', column: 'contact_id', deleteOnConflict: true },
  { table: 'meta_conversion_event_logs', column: 'contact_id' },
  { table: 'whatsapp_attribution', column: 'contact_id' },
  { table: 'whatsapp_web_contacts', column: 'contact_id' },
  { table: 'whatsapp_web_messages', column: 'contact_id' },
  { table: 'whatsapp_web_attribution', column: 'contact_id' },
  { table: 'payment_flows', column: 'contact_id' },
  { table: 'sessions', column: 'contact_id' }
]

function contactPriorityScore(contact = {}) {
  let score = 0
  const id = String(contact.id || '')
  const source = String(contact.source || '').toLowerCase()

  if (!id.startsWith('waweb_contact_')) score += 1000
  if (Number(contact.total_paid || 0) > 0) score += 500
  if (Number(contact.purchases_count || 0) > 0) score += 250
  if (source.includes('gohighlevel') || source.includes('highlevel')) score += 150
  if (normalizePhoneForStorage(contact.phone) === contact.phone) score += 50

  return score
}

function sortContactsByPriority(a, b) {
  const scoreDiff = contactPriorityScore(b) - contactPriorityScore(a)
  if (scoreDiff !== 0) return scoreDiff
  return String(a.created_at || '').localeCompare(String(b.created_at || ''))
}

async function updateContactReferences(fromId, toId) {
  for (const reference of CONTACT_REFERENCE_TABLES) {
    try {
      await db.run(
        `UPDATE ${reference.table} SET ${reference.column} = ? WHERE ${reference.column} = ?`,
        [toId, fromId]
      )
    } catch (error) {
      if (reference.deleteOnConflict) {
        await db.run(
          `DELETE FROM ${reference.table} WHERE ${reference.column} = ?`,
          [fromId]
        )
        continue
      }

      logger.warn(`No se pudo reasignar ${reference.table}.${reference.column} de ${fromId} a ${toId}: ${error.message}`)
    }
  }
}

async function syncContactPhoneColumns(contactId, canonicalPhone) {
  if (!contactId || !canonicalPhone) return

  const updates = [
    ['whatsapp_attribution', 'phone'],
    ['whatsapp_web_contacts', 'phone'],
    ['whatsapp_web_messages', 'phone'],
    ['whatsapp_web_attribution', 'phone'],
    ['payment_flows', 'contact_phone']
  ]

  for (const [table, column] of updates) {
    try {
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE contact_id = ?`, [canonicalPhone, contactId])
    } catch (error) {
      logger.warn(`No se pudo normalizar ${table}.${column} para ${contactId}: ${error.message}`)
    }
  }
}

export async function findContactByPhoneCandidates(phone, { excludeId = null } = {}) {
  const candidates = buildPhoneMatchCandidates(phone)
  if (!candidates.length) return null

  const placeholders = candidates.map(() => '?').join(', ')
  const params = [...candidates]
  const excludeClause = excludeId ? ' AND id != ?' : ''
  if (excludeId) params.push(excludeId)

  const rows = await db.all(
    `SELECT id, phone, full_name, source, total_paid, purchases_count, created_at
     FROM contacts
     WHERE phone IN (${placeholders})${excludeClause}`,
    params
  )

  return rows.sort(sortContactsByPriority)[0] || null
}

export async function mergeContactIds({ fromId, toId, canonicalPhone = null }) {
  if (!fromId || !toId || fromId === toId) return toId

  const [fromContact, toContact] = await Promise.all([
    db.get('SELECT * FROM contacts WHERE id = ?', [fromId]),
    db.get('SELECT * FROM contacts WHERE id = ?', [toId])
  ])

  if (!fromContact || !toContact) return toId

  const normalizedPhone = canonicalPhone || normalizePhoneForStorage(toContact.phone || fromContact.phone)
  const totalPaid = Math.max(Number(fromContact.total_paid || 0), Number(toContact.total_paid || 0))
  const purchasesCount = Math.max(Number(fromContact.purchases_count || 0), Number(toContact.purchases_count || 0))

  await db.run('UPDATE contacts SET phone = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [fromId])
  await updateContactReferences(fromId, toId)

  await db.run(`
    UPDATE contacts SET
      phone = COALESCE(?, phone),
      full_name = COALESCE(NULLIF(full_name, ''), ?),
      first_name = COALESCE(NULLIF(first_name, ''), ?),
      last_name = COALESCE(NULLIF(last_name, ''), ?),
      source = COALESCE(NULLIF(source, ''), ?),
      visitor_id = COALESCE(NULLIF(visitor_id, ''), ?),
      attribution_url = COALESCE(NULLIF(attribution_url, ''), ?),
      attribution_session_source = COALESCE(NULLIF(attribution_session_source, ''), ?),
      attribution_medium = COALESCE(NULLIF(attribution_medium, ''), ?),
      attribution_ctwa_clid = COALESCE(NULLIF(attribution_ctwa_clid, ''), ?),
      attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, ''), ?),
      attribution_ad_id = COALESCE(NULLIF(attribution_ad_id, ''), ?),
      total_paid = CASE WHEN COALESCE(total_paid, 0) < ? THEN ? ELSE total_paid END,
      purchases_count = CASE WHEN COALESCE(purchases_count, 0) < ? THEN ? ELSE purchases_count END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    normalizedPhone || null,
    fromContact.full_name || null,
    fromContact.first_name || null,
    fromContact.last_name || null,
    fromContact.source || null,
    fromContact.visitor_id || null,
    fromContact.attribution_url || null,
    fromContact.attribution_session_source || null,
    fromContact.attribution_medium || null,
    fromContact.attribution_ctwa_clid || null,
    fromContact.attribution_ad_name || null,
    fromContact.attribution_ad_id || null,
    totalPaid,
    totalPaid,
    purchasesCount,
    purchasesCount,
    toId
  ])

  await db.run('DELETE FROM contacts WHERE id = ?', [fromId])
  await syncContactPhoneColumns(toId, normalizedPhone)
  logger.info(`Contactos fusionados por telefono: ${fromId} -> ${toId}`)

  return toId
}

export async function prepareContactPhoneUpsert({ contactId, phone }) {
  const canonicalPhone = normalizePhoneForStorage(phone)
  if (!contactId || !canonicalPhone) {
    return { phone: canonicalPhone || phone || null, mergeFromContactId: null }
  }

  const matched = await findContactByPhoneCandidates(canonicalPhone, { excludeId: contactId })
  if (!matched) {
    return { phone: canonicalPhone, mergeFromContactId: null }
  }

  const targetExists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
  if (targetExists) {
    await mergeContactIds({ fromId: matched.id, toId: contactId, canonicalPhone })
    return { phone: canonicalPhone, mergeFromContactId: null }
  }

  await db.run('UPDATE contacts SET phone = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [matched.id])
  return { phone: canonicalPhone, mergeFromContactId: matched.id }
}

export async function finalizePreparedPhoneUpsert(prepared, contactId) {
  if (!prepared?.mergeFromContactId || !contactId) return contactId

  return mergeContactIds({
    fromId: prepared.mergeFromContactId,
    toId: contactId,
    canonicalPhone: prepared.phone
  })
}
