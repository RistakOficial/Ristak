import { db, databaseDialect } from '../config/database.js'
import { createRistakId } from '../utils/idGenerator.js'
import { normalizePhoneForAccount } from '../utils/accountLocale.js'

const clean = value => String(value || '').trim()
export const CONTACT_BLOCK_PUBLIC_MESSAGE = 'No se pudo completar la solicitud con estos datos.'

export function normalizeBlockedIdentity(type, value) {
  const raw = clean(value)
  if (type === 'contact') return raw && raw.length <= 180 ? raw : ''
  if (type === 'email') {
    return raw.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : ''
  }
  if (type !== 'phone' || !/^(?:\+|00)[\d\s().-]+$/.test(raw)) return ''
  let digits = raw.replace(/\D/g, '')
  if (raw.startsWith('00')) digits = digits.slice(2)
  // Only the documented WhatsApp Mexico alias; never compare national suffixes.
  if (/^521\d{10}$/.test(digits)) digits = `52${digits.slice(3)}`
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : ''
}

function invalidIdentity() {
  return Object.assign(new Error('Indica un correo válido o un teléfono completo con + y código de país.'), { status: 400, code: 'invalid_block_identity' })
}

async function blockingPhone(value) {
  const raw = clean(value)
  if (!raw) return ''
  const exact = normalizeBlockedIdentity('phone', raw)
  if (exact || raw.startsWith('+') || raw.startsWith('00')) return exact
  return normalizeBlockedIdentity('phone', await normalizePhoneForAccount(raw))
}

// Serialize policy changes with the final local write. PostgreSQL locks are
// per exact identity and held until commit; SQLite uses its transaction queue.
// Keep external provider calls outside these short local write transactions.
export async function withContactBlockPolicy(identities, callback) {
  const keys = new Set()
  const add = (type, value) => { if (value) keys.add(`${type}:${value}`) }
  for (const identity of identities) {
    add('contact', clean(identity.contactId))
    add('email', normalizeBlockedIdentity('email', identity.email))
    add('phone', await blockingPhone(identity.phone))
    if (identity.contactId) {
      const row = await db.get('SELECT email, phone FROM contacts WHERE id = ?', [identity.contactId])
      add('email', normalizeBlockedIdentity('email', row?.email))
      add('phone', await blockingPhone(row?.phone))
    }
  }
  return db.transaction(async () => {
    if (databaseDialect === 'postgres') {
      for (const key of [...keys].sort()) await db.get('SELECT pg_advisory_xact_lock(hashtext(?))', [`contact-block:${key}`])
    }
    return callback()
  })
}

export function contactBlockedError() {
  // Public callers must not expose the rule, matched contact, reason or identity.
  return Object.assign(new Error(CONTACT_BLOCK_PUBLIC_MESSAGE), { status: 403, code: 'request_unavailable' })
}

export async function findContactBlock({ contactId, email, phone } = {}, { database = db } = {}) {
  const keys = []
  const add = (type, value) => {
    const normalized = normalizeBlockedIdentity(type, value)
    if (normalized && !keys.some(key => key[0] === type && key[1] === normalized)) keys.push([type, normalized])
  }
  add('contact', contactId)
  add('email', email)
  if (phone) add('phone', await blockingPhone(phone))
  if (contactId) {
    const contact = await database.get('SELECT email, phone FROM contacts WHERE id = ?', [contactId])
    add('email', contact?.email)
    if (contact?.phone) add('phone', await blockingPhone(contact.phone))
  }
  // Only exact primary identity lookup: no name search, national suffix match,
  // or propagation through unverified additional phone numbers.
  const normalizedEmail = normalizeBlockedIdentity('email', email)
  const normalizedPhone = await blockingPhone(phone)
  if (!contactId && (normalizedEmail || normalizedPhone)) {
    const rows = []
    if (normalizedEmail) rows.push(...await database.all("SELECT id, email, phone FROM contacts WHERE LOWER(COALESCE(email, '')) = ?", [normalizedEmail]))
    if (normalizedPhone) rows.push(...await database.all('SELECT id, email, phone FROM contacts WHERE phone = ?', [normalizedPhone]))
    for (const row of rows) {
      add('contact', row.id)
      add('email', row.email)
      add('phone', await blockingPhone(row.phone))
    }
  }
  if (!keys.length) return null
  return database.get(`SELECT id FROM contact_blocks WHERE ${keys.map(() => '(identity_type = ? AND identity_value = ?)').join(' OR ')} LIMIT 1`, keys.flat())
}

export async function assertContactNotBlocked(identity, options) {
  if (await findContactBlock(identity, options)) throw contactBlockedError()
}

export async function listContactBlocks({ search = '', limit = 100, offset = 0 } = {}) {
  const term = clean(search).toLowerCase()
  const escaped = term.replace(/[\\%_]/g, value => `\\${value}`)
  const where = term ? "WHERE LOWER(identity_value) LIKE ? ESCAPE '\\' OR LOWER(reason) LIKE ? ESCAPE '\\'" : ''
  const params = term ? [`%${escaped}%`, `%${escaped}%`] : []
  const pageSize = Math.floor(Math.max(1, Math.min(100, Number(limit) || 100)))
  const pageOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0
  const rows = await db.all(`SELECT id, identity_type, identity_value, reason, created_at,
    CASE WHEN identity_type = 'contact' THEN (SELECT full_name FROM contacts WHERE contacts.id = contact_blocks.identity_value) END AS contact_name
    FROM contact_blocks ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, pageSize, pageOffset])
  const count = await db.get(`SELECT COUNT(*) AS total FROM contact_blocks ${where}`, params)
  return { items: rows, total: Number(count.total), limit: pageSize, offset: pageOffset }
}

export async function addContactBlock({ identityType, identityValue, reason = '', actorId = null } = {}) {
  const value = normalizeBlockedIdentity(identityType, identityValue)
  if (!value) throw invalidIdentity()
  if (identityType === 'contact' && !(await db.get('SELECT id FROM contacts WHERE id = ?', [value]))) {
    throw Object.assign(new Error('Contacto no encontrado.'), { status: 404 })
  }
  const identity = identityType === 'contact' ? { contactId: value } : { [identityType]: value }
  return withContactBlockPolicy([identity], async () => {
    await db.run(`INSERT INTO contact_blocks (id, identity_type, identity_value, reason, created_by)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(identity_type, identity_value) DO NOTHING`,
    [createRistakId('contact_block'), identityType, value, clean(reason).slice(0, 500), actorId])
    return db.get('SELECT id, identity_type, identity_value, reason, created_at FROM contact_blocks WHERE identity_type = ? AND identity_value = ?', [identityType, value])
  })
}

export async function removeContactBlock(id) {
  return db.run('DELETE FROM contact_blocks WHERE id = ?', [clean(id)])
}
