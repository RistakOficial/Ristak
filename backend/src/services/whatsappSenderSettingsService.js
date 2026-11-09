import { databaseDialect, db, getAppConfig, setAppConfig } from '../config/database.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { isOfficialWhatsAppApiProvider } from './whatsapp/providers/providerRegistry.js'

export const WHATSAPP_SENDER_CONFIG_KEYS = {
  senderPhone: 'whatsapp_api_sender_phone',
  phoneNumberId: 'whatsapp_api_phone_number_id',
  wabaId: 'whatsapp_api_waba_id',
  provider: 'whatsapp_api_provider'
}

export function getWhatsAppBusinessPhone(row = {}) {
  return normalizePhoneForStorage(row.phone_number) || normalizePhoneForStorage(row.display_phone_number) ||
    normalizePhoneForStorage(row.qr_connected_phone)
}

function hasOfficialApi(row = {}) {
  return isOfficialWhatsAppApiProvider(row.provider) && Number(row.api_send_enabled ?? 1) === 1
}

function hasConfiguredSender(row = {}) {
  const businessPhone = getWhatsAppBusinessPhone(row)
  const qrPhone = normalizePhoneForStorage(row.qr_connected_phone)
  return Boolean(businessPhone && (
    hasOfficialApi(row) ||
    (row.provider === 'meta_direct' && row.status === 'AUTHORIZATION_REQUIRED') ||
    (Number(row.qr_send_enabled) === 1 && (!qrPhone || qrPhone === businessPhone) && (
      qrPhone || row.qr_last_connected_at ||
      ['connected', 'reconnecting', 'restarting', 'connection_replaced'].includes(row.qr_status)
    ))
  ))
}

function findSameNumberApi(row, candidates) {
  const phone = getWhatsAppBusinessPhone(row)
  return candidates.find(candidate => (
    hasOfficialApi(candidate) && getWhatsAppBusinessPhone(candidate) === phone
  ))
}

export function getWhatsAppSenderPositions(rows, primary) {
  const positions = new Map()
  const primaryPhone = primary && getWhatsAppBusinessPhone(primary)
  if (primaryPhone) positions.set(primaryPhone, 1)
  for (const row of rows) {
    if (!hasConfiguredSender(row)) continue
    const phone = getWhatsAppBusinessPhone(row)
    if (!positions.has(phone)) positions.set(phone, positions.size + 1)
  }
  return positions
}

export async function reconcileWhatsAppDefaultSender({ phoneNumberId, makeDefault = false, previousPhone } = {}) {
  return db.transaction(async (tx) => {
    // SQLite ya toma BEGIN IMMEDIATE. En PostgreSQL todas las promociones y la
    // reparación inicial usan el mismo candado dentro de la transacción.
    if (databaseDialect === 'postgres') {
      await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))', ['ristak:whatsapp-default-sender'])
    }

    const rows = await tx.all(`
      SELECT id, provider, status, waba_id, phone_number, display_phone_number,
        api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone,
        qr_last_connected_at, is_default_sender
      FROM whatsapp_api_phone_numbers
      ORDER BY is_default_sender DESC, created_at ASC, id ASC
      ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
    `)
    const marked = rows.find(row => Number(row.is_default_sender) === 1)
    const eligible = rows.filter(hasConfiguredSender)
    const requested = eligible.find(row => row.id === phoneNumberId)
    if (makeDefault && !requested) throw new Error('Ese número de WhatsApp no está conectado')

    const config = WHATSAPP_SENDER_CONFIG_KEYS
    const configuredId = await getAppConfig(config.phoneNumberId)
    const previous = marked || previousPhone
    const previousNumber = previous && getWhatsAppBusinessPhone(previous)
    const sameNumber = previousNumber && eligible.find(row => getWhatsAppBusinessPhone(row) === previousNumber)
    const selected = (makeDefault ? requested : null) ||
      eligible.find(row => row.id === marked?.id) ||
      sameNumber ||
      eligible.find(row => row.id === configuredId) ||
      requested ||
      eligible[0]
    const primary = selected && (
      hasOfficialApi(selected) ? selected : findSameNumberApi(selected, eligible) || selected
    )
    const id = primary?.id || ''

    await tx.run(`
      UPDATE whatsapp_api_phone_numbers
      SET is_default_sender = CASE WHEN id = ? THEN 1 ELSE 0 END
      WHERE (id = ? AND COALESCE(is_default_sender, 0) != 1)
         OR (id != ? AND COALESCE(is_default_sender, 0) != 0)
    `, [id, id, id])

    const senderPhone = primary?.phone_number || primary?.display_phone_number || primary?.qr_connected_phone || ''
    const currentSender = await getAppConfig(config.senderPhone)
    const currentWaba = await getAppConfig(config.wabaId)
    const waba = primary?.waba_id || ''
    if ((configuredId || '') !== id) await setAppConfig(config.phoneNumberId, id)
    if ((currentSender || '') !== senderPhone) await setAppConfig(config.senderPhone, senderPhone)
    if ((currentWaba || '') !== waba) await setAppConfig(config.wabaId, waba)
    if (primary && hasOfficialApi(primary) && (makeDefault || marked?.id !== id)) {
      await setAppConfig(config.provider, primary.provider)
    }

    return primary || null
  })
}
