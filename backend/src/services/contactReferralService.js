import { db } from '../config/database.js'

const MAX_REFERRAL_DEPTH = 25

function cleanContactId(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

export function getRequestedReferrerId(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'referredByContactId')) {
    return cleanContactId(body.referredByContactId)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'referred_by_contact_id')) {
    return cleanContactId(body.referred_by_contact_id)
  }
  return undefined
}

export async function validateContactReferrer({ contactId, referredByContactId }) {
  const cleanContactIdValue = cleanContactId(contactId)
  const cleanReferrerId = cleanContactId(referredByContactId)
  if (!cleanReferrerId) return null

  if (cleanContactIdValue && cleanContactIdValue === cleanReferrerId) {
    throw Object.assign(new Error('Un contacto no puede recomendarse a sí mismo'), {
      code: 'CONTACT_REFERRAL_SELF_REFERENCE',
      status: 400
    })
  }

  const referrer = await db.get(
    'SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [cleanReferrerId]
  )
  if (!referrer) {
    throw Object.assign(new Error('El contacto recomendado por ya no existe o fue eliminado'), {
      code: 'CONTACT_REFERRER_NOT_FOUND',
      status: 400
    })
  }

  if (!cleanContactIdValue) return cleanReferrerId

  const visited = new Set([cleanContactIdValue])
  let cursor = cleanReferrerId
  for (let depth = 1; cursor; depth += 1) {
    if (depth > MAX_REFERRAL_DEPTH) {
      throw Object.assign(new Error('La cadena de recomendaciones es demasiado larga'), {
        code: 'CONTACT_REFERRAL_DEPTH_EXCEEDED',
        status: 400
      })
    }
    if (visited.has(cursor)) {
      throw Object.assign(new Error('Esa relación formaría un ciclo entre contactos'), {
        code: 'CONTACT_REFERRAL_CYCLE',
        status: 400
      })
    }
    visited.add(cursor)
    const row = await db.get(
      'SELECT referred_by_contact_id FROM contacts WHERE id = ? LIMIT 1',
      [cursor]
    )
    cursor = cleanContactId(row?.referred_by_contact_id)
  }

  return cleanReferrerId
}
