import { db } from '../config/database.js'

export const CONTACT_REPLY_CHANNELS = Object.freeze([
  'whatsapp',
  'sms',
  'messenger',
  'instagram',
  'email'
])

const CONTACT_REPLY_CHANNEL_SET = new Set(CONTACT_REPLY_CHANNELS)

function cleanString(value = '') {
  return String(value || '').trim()
}

export function normalizeContactReplyChannel(value = '') {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  const aliases = {
    whatsapp_api: 'whatsapp',
    whatsapp_qr: 'whatsapp',
    ghl_whatsapp: 'whatsapp',
    wa: 'whatsapp',
    sms_qr: 'sms',
    ghl_sms: 'sms',
    mms: 'sms',
    facebook: 'messenger',
    facebook_messenger: 'messenger',
    instagram_dm: 'instagram',
    ig: 'instagram',
    correo: 'email',
    mail: 'email'
  }
  const channel = aliases[normalized] || normalized
  return CONTACT_REPLY_CHANNEL_SET.has(channel) ? channel : null
}

export async function getContactReplyChannelPreference(contactId) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return null

  const row = await db.get(`
    SELECT contact_id, channel, route_id, route_label,
           selected_at, selected_by_user_id, selection_source
    FROM contact_reply_channel_preferences
    WHERE contact_id = ?
    LIMIT 1
  `, [cleanContactId]).catch(() => null)
  const channel = normalizeContactReplyChannel(row?.channel)
  if (!row || !channel) return null

  return {
    contactId: row.contact_id,
    channel,
    routeId: row.route_id || null,
    routeLabel: row.route_label || null,
    selectedAt: row.selected_at || null,
    selectedByUserId: row.selected_by_user_id || null,
    source: row.selection_source || 'manual'
  }
}

export async function setContactReplyChannelPreference(contactId, channel, {
  routeId = null,
  routeLabel = null,
  selectedByUserId = null,
  source = 'manual'
} = {}) {
  const cleanContactId = cleanString(contactId)
  const normalizedChannel = normalizeContactReplyChannel(channel)
  if (!cleanContactId) throw new TypeError('contactId es obligatorio para guardar el canal de respuesta')
  if (!normalizedChannel) {
    const error = new TypeError('El canal de respuesta no es válido')
    error.code = 'INVALID_CONTACT_REPLY_CHANNEL'
    throw error
  }

  const contact = await db.get('SELECT id FROM contacts WHERE id = ? LIMIT 1', [cleanContactId])
  if (!contact) {
    const error = new Error('Contacto no encontrado')
    error.code = 'CONTACT_NOT_FOUND'
    throw error
  }

  await db.run(`
    INSERT INTO contact_reply_channel_preferences (
      contact_id, channel, route_id, route_label,
      selected_at, selected_by_user_id, selection_source, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(contact_id) DO UPDATE SET
      channel = excluded.channel,
      route_id = excluded.route_id,
      route_label = excluded.route_label,
      selected_at = CURRENT_TIMESTAMP,
      selected_by_user_id = excluded.selected_by_user_id,
      selection_source = excluded.selection_source,
      updated_at = CURRENT_TIMESTAMP
  `, [
    cleanContactId,
    normalizedChannel,
    cleanString(routeId) || null,
    cleanString(routeLabel) || null,
    cleanString(selectedByUserId) || null,
    cleanString(source) || 'manual'
  ])

  return getContactReplyChannelPreference(cleanContactId)
}
