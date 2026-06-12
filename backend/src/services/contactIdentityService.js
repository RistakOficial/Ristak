import crypto from 'crypto'
import { db, getContactReferenceTables, isWhatsAppAutoCreatedContact } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'

// Prefijos de IDs de contacto generados por Ristak. Un id sin ninguno de estos
// prefijos se asume que es un ID de HighLevel usado como PK (datos legacy).
export const RISTAK_CONTACT_ID_PREFIXES = [
  'rstk_',
  'waapi_contact_',
  'manual_contact_',
  'meta_social_contact_',
  'site_contact_'
]

export function isRistakContactId(contactId) {
  const id = String(contactId || '')
  return RISTAK_CONTACT_ID_PREFIXES.some(prefix => id.startsWith(prefix))
}

// ID canónico de contacto de Ristak. Todos los contactos nuevos deben crearse
// con este formato; los IDs externos (HighLevel, WhatsApp) son solo referencias.
export function generateContactId() {
  return `rstk_contact_${crypto.randomUUID()}`
}

function contactPriorityScore(contact = {}) {
  let score = 0
  const source = String(contact.source || '').toLowerCase()

  if (!isWhatsAppAutoCreatedContact(contact)) score += 1000
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
  const references = await getContactReferenceTables()

  for (const reference of references) {
    try {
      await db.run(
        `UPDATE ${reference.table} SET contact_id = ? WHERE contact_id = ?`,
        [toId, fromId]
      )
    } catch (error) {
      if (reference.deleteOnConflict) {
        await db.run(
          `DELETE FROM ${reference.table} WHERE contact_id = ?`,
          [fromId]
        )
        continue
      }

      logger.warn(`No se pudo reasignar ${reference.table}.contact_id de ${fromId} a ${toId}: ${error.message}`)
    }
  }
}

/**
 * Liga un contacto local con su ID de HighLevel. Limpia cualquier otro contacto
 * que tuviera ese mismo ghl_contact_id para que el vínculo sea 1 a 1.
 */
export async function linkContactToGhl(localContactId, ghlContactId) {
  const localId = String(localContactId || '').trim()
  const ghlId = String(ghlContactId || '').trim()
  if (!localId || !ghlId) return

  await db.run(
    'UPDATE contacts SET ghl_contact_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE ghl_contact_id = ? AND id != ?',
    [ghlId, localId]
  )
  await db.run(
    'UPDATE contacts SET ghl_contact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [ghlId, localId]
  )
}

/**
 * Resuelve el ID local (Ristak) de un contacto a partir de su ID de HighLevel.
 * Busca primero por ghl_contact_id y luego por id (datos legacy donde el ID de
 * GHL era la primary key); en ese caso autocompleta el vínculo.
 * Devuelve null si no existe localmente.
 */
export async function resolveContactIdByGhlId(ghlContactId) {
  const ghlId = String(ghlContactId || '').trim()
  if (!ghlId) return null

  const byLink = await db.get('SELECT id FROM contacts WHERE ghl_contact_id = ? LIMIT 1', [ghlId])
  if (byLink?.id) return byLink.id

  const legacy = await db.get('SELECT id, ghl_contact_id FROM contacts WHERE id = ? LIMIT 1', [ghlId])
  if (legacy?.id) {
    // Autocompletar el vínculo solo para PKs legacy de GHL; si nos pasaron un
    // ID local de Ristak no hay que registrarlo como ID de HighLevel.
    if (!legacy.ghl_contact_id && !isRistakContactId(legacy.id)) {
      await db.run('UPDATE contacts SET ghl_contact_id = ? WHERE id = ?', [ghlId, legacy.id])
    }
    return legacy.id
  }

  return null
}

/**
 * Traducción inversa: dado un ID local de Ristak devuelve el ID de HighLevel
 * ligado (ghl_contact_id), o el mismo id si es una PK legacy de GHL.
 * Devuelve null si el contacto no está ligado a HighLevel.
 */
export async function getGhlContactIdForLocalContact(localContactId) {
  const id = String(localContactId || '').trim()
  if (!id) return null

  const row = await db.get('SELECT id, ghl_contact_id FROM contacts WHERE id = ? LIMIT 1', [id])
  if (!row) {
    // Si no existe localmente puede que ya nos hayan pasado un ID de GHL.
    return isRistakContactId(id) ? null : id
  }
  if (String(row.ghl_contact_id || '').trim()) return row.ghl_contact_id
  if (!isRistakContactId(row.id)) return row.id
  return null
}

/**
 * Resuelve el contacto local para un contacto de HighLevel y, si no existe,
 * lo crea con ID propio de Ristak dejando el ID de GHL como referencia ligada.
 * Antes de crear intenta emparejar por teléfono o email para no duplicar.
 */
export async function resolveOrCreateContactForGhl({
  ghlContactId,
  phone = null,
  email = null,
  fullName = null,
  source = 'gohighlevel',
  createdAt = null
} = {}) {
  const ghlId = String(ghlContactId || '').trim()
  if (!ghlId) return { contactId: null, created: false }

  const resolved = await resolveContactIdByGhlId(ghlId)
  if (resolved) return { contactId: resolved, created: false }

  const byPhone = await findContactByPhoneCandidates(phone)
  if (byPhone?.id) {
    await linkContactToGhl(byPhone.id, ghlId)
    return { contactId: byPhone.id, created: false }
  }

  const cleanEmail = String(email || '').trim()
  if (cleanEmail) {
    const byEmail = await db.get(
      "SELECT id FROM contacts WHERE email IS NOT NULL AND email != '' AND LOWER(email) = LOWER(?) LIMIT 1",
      [cleanEmail]
    )
    if (byEmail?.id) {
      await linkContactToGhl(byEmail.id, ghlId)
      return { contactId: byEmail.id, created: false }
    }
  }

  const contactId = generateContactId()
  const canonicalPhone = normalizePhoneForStorage(phone) || phone || null

  await db.run(
    `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    [
      contactId,
      ghlId,
      canonicalPhone,
      cleanEmail || null,
      String(fullName || '').trim() || null,
      source,
      createdAt || null
    ]
  )

  return { contactId, created: true }
}

async function syncContactPhoneColumns(contactId, canonicalPhone) {
  if (!contactId || !canonicalPhone) return

  const updates = [
    ['whatsapp_attribution', 'phone'],
    ['whatsapp_api_contacts', 'phone'],
    ['whatsapp_api_messages', 'phone'],
    ['whatsapp_api_attribution', 'phone'],
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

  await db.run('UPDATE contacts SET phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [fromId])
  await updateContactReferences(fromId, toId)

  await db.run(`
    UPDATE contacts SET
      phone = COALESCE(?, phone),
      email = COALESCE(NULLIF(email, ''), ?),
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
    fromContact.email || null,
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

  await db.run('UPDATE contacts SET phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [matched.id])
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
