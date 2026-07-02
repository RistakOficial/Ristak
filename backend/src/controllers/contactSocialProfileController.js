import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

// Perfil social + contacto ENLAZADO de la misma persona.
//
// La misma persona en la misma plataforma (mismo platform + meta_user_id) puede
// existir como DOS contactos separados: uno de DM y otro de comentario. No los
// fusionamos, pero sí los enlazamos para mostrar el "otro" contacto en el panel
// y saltar entre ellos.
//
// El sender_id de un comentario lleva prefijo sintético `fb_comment:` / `ig_comment:`;
// el de un DM es el PSID/IGSID crudo. Con eso distinguimos el tipo de contacto.

function detectSocialKind(senderId) {
  const value = String(senderId || '')
  if (value.startsWith('fb_comment:') || value.startsWith('ig_comment:')) return 'comment'
  return 'dm'
}

function platformLabel(platform) {
  switch (String(platform || '').toLowerCase()) {
    case 'instagram':
      return 'Instagram'
    case 'messenger':
    case 'facebook':
      return 'Facebook'
    default:
      return platform ? String(platform) : 'Meta'
  }
}

function cleanString(value) {
  const str = String(value ?? '').trim()
  return str.length ? str : null
}

// GET /api/contacts/:id/linked-social
// Devuelve el/los perfiles sociales del contacto y, si existe, el contacto
// enlazado (misma persona, mismo canal) que vive como registro separado.
export const getContactLinkedSocial = async (req, res) => {
  try {
    const contactId = String(req.params.id || '').trim()
    if (!contactId) return res.status(400).json({ success: false, error: 'Falta el contacto' })

    // Perfiles sociales de ESTE contacto (puede tener DM y comentario a la vez).
    const ownProfiles = await db.all(
      `SELECT platform, sender_id, profile_name, username, profile_picture_url, meta_user_id
         FROM meta_social_contacts
        WHERE contact_id = ?`,
      [contactId]
    )

    if (!ownProfiles.length) {
      return res.json({ success: true, profiles: [], linked: [] })
    }

    const profiles = ownProfiles.map((row) => ({
      platform: row.platform,
      platformLabel: platformLabel(row.platform),
      kind: detectSocialKind(row.sender_id),
      name: cleanString(row.profile_name),
      username: cleanString(row.username),
      photo: cleanString(row.profile_picture_url),
      metaUserId: cleanString(row.meta_user_id)
    }))

    // Contactos enlazados: misma plataforma + meta_user_id, distinto contact_id.
    const linkKeys = profiles
      .filter((profile) => profile.metaUserId)
      .map((profile) => ({ platform: profile.platform, metaUserId: profile.metaUserId }))

    const linkedMap = new Map()
    for (const key of linkKeys) {
      const rows = await db.all(
        `SELECT c.id AS contact_id,
                c.full_name AS contact_name,
                s.platform,
                s.sender_id,
                s.profile_name,
                s.username,
                s.profile_picture_url
           FROM meta_social_contacts s
           JOIN contacts c ON c.id = s.contact_id
          WHERE s.platform = ?
            AND s.meta_user_id = ?
            AND s.contact_id IS NOT NULL
            AND s.contact_id <> ?
            AND c.deleted_at IS NULL`,
        [key.platform, key.metaUserId, contactId]
      )
      for (const row of rows) {
        if (!row.contact_id || linkedMap.has(row.contact_id)) continue
        linkedMap.set(row.contact_id, {
          contactId: String(row.contact_id),
          platform: row.platform,
          platformLabel: platformLabel(row.platform),
          kind: detectSocialKind(row.sender_id),
          name: cleanString(row.profile_name) || cleanString(row.contact_name),
          username: cleanString(row.username),
          photo: cleanString(row.profile_picture_url)
        })
      }
    }

    res.json({
      success: true,
      profiles,
      linked: Array.from(linkedMap.values())
    })
  } catch (error) {
    logger.error('Error leyendo perfil social enlazado del contacto:', error)
    res.status(500).json({ success: false, error: 'No se pudo leer el perfil social del contacto' })
  }
}
