import { db, getContactReferenceTables, isWhatsAppAutoCreatedContact } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { createRistakId } from '../utils/idGenerator.js'
// (CNT-002) Para no perder custom_fields al fusionar.
import { mergeContactCustomFields, serializeContactCustomFieldsForDb } from '../utils/contactCustomFields.js'
import { formatContactName, normalizeContactNameFields } from '../utils/contactNameFormatter.js'
import { mergeConversationalAgentSafetyContactReferences } from '../utils/conversationalAgentSafetyMerge.js'
import { acquireConversationalInboundCommitLocks } from './conversationalInboundCommitLockService.js'
import { parseSortableTimestamp } from '../utils/sqlTimestampSort.js'

// (CNT-002) Parser tolerante de tags almacenados como JSON array (o null/legacy).
function parseStoredTags(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseStoredCustomFields(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

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

// ID canónico de contacto de Ristak. Los IDs legacy con UUID siguen siendo válidos;
// los nuevos usan cola corta alfanumérica para verse como IDs de plataforma.
export function generateContactId() {
  return createRistakId('contact')
}

function contactPriorityScore(contact = {}) {
  let score = 0
  const source = String(contact.source || '').toLowerCase()

  // Una identidad activa siempre debe ganar sobre una copia en la papelera.
  // Conservamos la fila eliminada como último recurso para que un inbound nuevo
  // pueda reactivarla sin crear otro contacto con el mismo teléfono.
  if (!contact.deleted_at) score += 10_000
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

const cleanString = (value) => String(value || '').trim()

function normalizeContactPhone(value) {
  return normalizePhoneForStorage(value) || cleanString(value) || null
}

async function updateContactReferences(fromId, toId) {
  const references = await getContactReferenceTables()
  await mergeConversationalAgentSafetyContactReferences({
    connection: db,
    fromContactId: fromId,
    toContactId: toId
  })

  let referenceIndex = 0
  for (const reference of references) {
    if (reference.mergeStrategy === 'conversational_agent_safety') continue
    const savepoint = `contact_merge_reference_${referenceIndex++}`
    await db.exec(`SAVEPOINT ${savepoint}`)
    let updateError = null
    try {
      await db.run(
        `UPDATE ${reference.table} SET contact_id = ? WHERE contact_id = ?`,
        [toId, fromId]
      )
    } catch (error) {
      updateError = error
    }

    if (!updateError) {
      await db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      continue
    }

    // PostgreSQL deja la transacción en estado abortado después de cualquier
    // error SQL. El savepoint conserva el comportamiento tolerante del merge
    // sin soltar los advisory locks ni convertir una colisión aislada en un
    // COMMIT parcial/inutilizable.
    await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    if (reference.deleteOnConflict) {
      await db.run(
        `DELETE FROM ${reference.table} WHERE contact_id = ?`,
        [fromId]
      )
      continue
    }

    logger.warn(`No se pudo reasignar ${reference.table}.contact_id de ${fromId} a ${toId}: ${updateError.message}`)
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
  const nameFields = normalizeContactNameFields({ fullName })

  await db.run(
    `INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    [
      contactId,
      ghlId,
      canonicalPhone,
      cleanEmail || null,
      nameFields.fullName || null,
      source,
      createdAt || null
    ]
  )

  return { contactId, created: true }
}

async function syncContactPhoneColumns(contactId, canonicalPhone) {
  if (!contactId || !canonicalPhone) return

  const updates = [
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

export async function listContactPhoneNumbers(contactId) {
  const id = cleanString(contactId)
  if (!id) return []

  const rows = await db.all(
    `SELECT id, phone, label, is_primary, source, created_at, updated_at
     FROM contact_phone_numbers
     WHERE contact_id = ?
     ORDER BY is_primary DESC, created_at ASC, phone ASC`,
    [id]
  ).catch(() => [])

  return rows.map(row => ({
    id: row.id,
    phone: row.phone,
    label: row.label || '',
    isPrimary: Boolean(row.is_primary),
    is_primary: Boolean(row.is_primary),
    source: row.source || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
}

export async function getContactPhoneValues(contactId, primaryPhone = null) {
  const values = new Set()
  const addCandidates = (value) => {
    buildPhoneMatchCandidates(value).forEach(candidate => {
      const clean = cleanString(candidate)
      if (clean) values.add(clean)
    })
  }

  addCandidates(primaryPhone)

  const rows = await listContactPhoneNumbers(contactId)
  rows.forEach(row => addCandidates(row.phone))

  return [...values]
}

export async function recordContactPhoneNumber({
  contactId,
  phone,
  label = '',
  isPrimary = false,
  source = 'manual',
  mergeConflicts = true
} = {}) {
  const id = cleanString(contactId)
  const canonicalPhone = normalizeContactPhone(phone)
  if (!id || !canonicalPhone) return null

  const existing = await db.get(
    'SELECT contact_id FROM contact_phone_numbers WHERE phone = ? LIMIT 1',
    [canonicalPhone]
  ).catch(() => null)

  if (existing?.contact_id && existing.contact_id !== id && mergeConflicts) {
    await mergeContactIds({
      fromId: existing.contact_id,
      toId: id,
      canonicalPhone: isPrimary ? canonicalPhone : null
    })
  }

  if (isPrimary) {
    await db.run(
      `UPDATE contact_phone_numbers
       SET is_primary = 0,
           label = CASE WHEN label = 'Principal' THEN 'Adicional' ELSE label END,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ?`,
      [id]
    ).catch(() => {})
  }

  await db.run(`
    INSERT INTO contact_phone_numbers (
      id, contact_id, phone, label, is_primary, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      contact_id = excluded.contact_id,
      label = COALESCE(NULLIF(excluded.label, ''), contact_phone_numbers.label),
      is_primary = CASE
        WHEN excluded.is_primary = 1 THEN 1
        ELSE contact_phone_numbers.is_primary
      END,
      source = COALESCE(NULLIF(excluded.source, ''), contact_phone_numbers.source),
      updated_at = CURRENT_TIMESTAMP
  `, [
    createRistakId('contact_phone'),
    id,
    canonicalPhone,
    cleanString(label) || (isPrimary ? 'Principal' : 'Adicional'),
    isPrimary ? 1 : 0,
    cleanString(source) || 'manual'
  ])

  return {
    phone: canonicalPhone,
    isPrimary: Boolean(isPrimary)
  }
}

export async function findContactByPhoneCandidates(phone, { excludeId = null } = {}) {
  const candidates = buildPhoneMatchCandidates(phone)
  if (!candidates.length) return null

  const placeholders = candidates.map(() => '?').join(', ')
  const params = [...candidates, ...candidates]
  const excludeClause = excludeId ? ' AND contacts.id != ?' : ''
  if (excludeId) params.push(excludeId)

  const rows = await db.all(
    `SELECT DISTINCT contacts.id, contacts.phone, contacts.full_name, contacts.source,
            contacts.total_paid, contacts.purchases_count, contacts.attribution_ctwa_clid,
            contacts.attribution_ad_name, contacts.attribution_ad_id, contacts.created_at,
            contacts.deleted_at
     FROM contacts
     LEFT JOIN contact_phone_numbers cpn ON cpn.contact_id = contacts.id
     WHERE (contacts.phone IN (${placeholders}) OR cpn.phone IN (${placeholders}))${excludeClause}`,
    params
  )

  return rows.sort(sortContactsByPriority)[0] || null
}

/**
 * Reactiva un contacto que volvió a escribir después de haber sido enviado a
 * la papelera. La comparación temporal evita que un reintento o una importación
 * histórica anterior al borrado deshaga una eliminación intencional.
 */
export async function restoreSoftDeletedContactForNewInbound({
  contactId,
  messageTimestamp,
  source = 'chat'
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) return { restored: false, reason: 'missing_contact' }

  const contact = await db.get(
    'SELECT id, deleted_at FROM contacts WHERE id = ? LIMIT 1',
    [cleanContactId]
  ).catch(() => null)
  if (!contact?.deleted_at) return { restored: false, reason: 'contact_active' }

  const deletedAtMs = parseSortableTimestamp(contact.deleted_at)
  const inboundAtMs = parseSortableTimestamp(messageTimestamp)
  if (!deletedAtMs || !inboundAtMs || inboundAtMs <= deletedAtMs) {
    return { restored: false, reason: 'inbound_not_newer_than_deletion' }
  }

  const result = await db.run(
    `UPDATE contacts
     SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NOT NULL`,
    [cleanContactId]
  )
  const restored = Number(result?.changes || 0) > 0
  if (restored) {
    logger.info(`[Contactos] ${cleanContactId} salió de la papelera por un inbound nuevo (${String(source || 'chat')}).`)
  }

  return { restored, reason: restored ? 'new_inbound' : 'already_restored' }
}

async function mergeContactIdsUnderCommitLocks({ fromId, toId, canonicalPhone = null }) {
  if (!fromId || !toId || fromId === toId) return toId

  const [fromContact, toContact] = await Promise.all([
    db.get('SELECT * FROM contacts WHERE id = ?', [fromId]),
    db.get('SELECT * FROM contacts WHERE id = ?', [toId])
  ])

  if (!fromContact || !toContact) return toId

  const normalizedPhone = canonicalPhone || normalizePhoneForStorage(toContact.phone || fromContact.phone)
  // (CNT-002) Conservar TODO al fusionar: usar SUM (no MAX) para totales, de modo que
  // el historial pagado de ambos contactos quede reflejado en el sobreviviente.
  const totalPaid = Number(fromContact.total_paid || 0) + Number(toContact.total_paid || 0)
  const purchasesCount = Number(fromContact.purchases_count || 0) + Number(toContact.purchases_count || 0)

  // (CNT-002) Unir tags de ambos contactos (sin duplicar).
  const mergedTags = (() => {
    const all = [...parseStoredTags(toContact.tags), ...parseStoredTags(fromContact.tags)]
    const seen = new Set()
    const result = []
    for (const tag of all) {
      const key = typeof tag === 'object' ? JSON.stringify(tag) : String(tag)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(tag)
    }
    return result
  })()
  const mergedTagsJson = JSON.stringify(mergedTags)

  // (CNT-002) Mezclar custom_fields: el sobreviviente (toContact) tiene prioridad,
  // pero los campos que solo existían en el absorbido (fromContact) se conservan.
  const mergedCustomFieldsJson = serializeContactCustomFieldsForDb(
    mergeContactCustomFields(
      parseStoredCustomFields(fromContact.custom_fields),
      parseStoredCustomFields(toContact.custom_fields)
    )
  )

  // (CNT-002) Conservar el vínculo a HighLevel y el WhatsApp preferido si el
  // sobreviviente no los tiene (prioridad: toContact, fallback fromContact).
  const mergedGhlContactId = (toContact.ghl_contact_id && String(toContact.ghl_contact_id).trim())
    ? toContact.ghl_contact_id
    : (fromContact.ghl_contact_id || null)
  const mergedPreferredWhatsApp = (toContact.preferred_whatsapp_phone_number_id && String(toContact.preferred_whatsapp_phone_number_id).trim())
    ? toContact.preferred_whatsapp_phone_number_id
    : (fromContact.preferred_whatsapp_phone_number_id || null)

  await db.run('UPDATE contacts SET phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [fromId])

  if (fromContact.phone) {
    await recordContactPhoneNumber({
      contactId: toId,
      phone: fromContact.phone,
      label: 'Adicional',
      source: 'merge',
      mergeConflicts: false
    }).catch(() => {})
  }

  await db.run(
    'UPDATE contact_phone_numbers SET contact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE contact_id = ?',
    [toId, fromId]
  ).catch(() => {})

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
      ghl_contact_id = ?,
      preferred_whatsapp_phone_number_id = ?,
      tags = ?,
      custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'},
      total_paid = ?,
      purchases_count = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    normalizedPhone || null,
    fromContact.email || null,
    formatContactName(fromContact.full_name) || null,
    formatContactName(fromContact.first_name) || null,
    formatContactName(fromContact.last_name, { allowLeadingConnectorLowercase: true }) || null,
    fromContact.source || null,
    fromContact.visitor_id || null,
    fromContact.attribution_url || null,
    fromContact.attribution_session_source || null,
    fromContact.attribution_medium || null,
    fromContact.attribution_ctwa_clid || null,
    fromContact.attribution_ad_name || null,
    fromContact.attribution_ad_id || null,
    mergedGhlContactId,
    mergedPreferredWhatsApp,
    mergedTagsJson,
    mergedCustomFieldsJson,
    totalPaid,
    purchasesCount,
    toId
  ])

  if (normalizedPhone) {
    await recordContactPhoneNumber({
      contactId: toId,
      phone: normalizedPhone,
      label: 'Principal',
      isPrimary: true,
      source: 'merge',
      mergeConflicts: false
    }).catch(() => {})
  }

  await db.run('DELETE FROM contacts WHERE id = ?', [fromId])
  await syncContactPhoneColumns(toId, normalizedPhone)
  logger.info(`Contactos fusionados por teléfono: ${fromId} -> ${toId}`)

  return toId
}

export async function mergeContactIds({ fromId, toId, canonicalPhone = null }) {
  if (!fromId || !toId || fromId === toId) return toId

  return db.transaction(async (transactionDatabase) => {
    // Un merge mueve filas inbound de fromId a toId. Debe competir tanto con
    // writers del origen como con el fence terminal del destino; de otro modo
    // una fila más nueva podría aparecer en el destino entre el último fence y
    // el INSERT de la cita. Todas las llaves se toman antes de leer/mover datos
    // y en el orden global definido por el servicio para evitar merge↔merge.
    await acquireConversationalInboundCommitLocks({
      contactIds: [fromId, toId],
      database: transactionDatabase
    })

    return mergeContactIdsUnderCommitLocks({ fromId, toId, canonicalPhone })
  })
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
