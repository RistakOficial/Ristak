import { getGHLClient } from './ghlClient.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const cacheByLocation = new Map()

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstString(...values) {
  for (const value of values) {
    const clean = cleanString(value)
    if (clean) return clean
  }
  return ''
}

function readBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = cleanString(value).toLowerCase()
  if (['true', '1', 'yes', 'enabled', 'active'].includes(normalized)) return true
  if (['false', '0', 'no', 'disabled', 'inactive'].includes(normalized)) return false
  return null
}

function getPhoneNumberRows(payload) {
  const candidates = [
    payload?.data?.phoneNumbers,
    payload?.data?.numbers,
    payload?.data?.items,
    payload?.data,
    payload?.phoneNumbers,
    payload?.numbers,
    payload?.items,
    payload?.result
  ]
  return candidates.find(Array.isArray) || []
}

function hasSmsCapability(row = {}) {
  const capabilities = row.capabilities && typeof row.capabilities === 'object'
    ? row.capabilities
    : {}
  const signals = [
    capabilities.sms,
    capabilities.SMS,
    row.sms,
    row.smsEnabled,
    row.sms_enabled,
    row.messagingEnabled,
    row.messaging_enabled
  ].map(readBoolean).filter((value) => value !== null)

  return signals.includes(true) || signals.length === 0
}

export function normalizeHighLevelActivePhoneNumbers(payload) {
  const seen = new Set()
  return getPhoneNumberRows(payload).flatMap((row, index) => {
    if (!row || typeof row !== 'object' || !hasSmsCapability(row)) return []
    const rawNumber = firstString(
      row.phoneNumber,
      row.phone_number,
      row.number,
      row.e164,
      row.phone,
      row.displayPhoneNumber,
      row.display_phone_number
    )
    const phoneNumber = normalizePhoneForStorage(rawNumber) || rawNumber
    if (!phoneNumber || seen.has(phoneNumber)) return []
    seen.add(phoneNumber)

    const id = firstString(row.id, row.phoneNumberId, row.phone_number_id, row.numberId, row.sid) || phoneNumber
    const label = firstString(row.friendlyName, row.friendly_name, row.label, row.name) || `Número ${index + 1}`
    const isDefault = [row.isDefault, row.is_default, row.default, row.defaultNumber]
      .map(readBoolean)
      .some((value) => value === true)

    return [{ id, phoneNumber, label, isDefault }]
  })
}

export function isHighLevelPhoneInventoryUnavailable(error) {
  return [400, 401, 403, 404].includes(Number(error?.status || error?.statusCode))
}

export async function getHighLevelPhoneNumbers({ client = null, forceRefresh = false, now = Date.now() } = {}) {
  const ghlClient = client || await getGHLClient()
  const locationId = cleanString(ghlClient.locationId) || 'configured-location'
  const cached = cacheByLocation.get(locationId)
  if (!forceRefresh && cached && now - cached.savedAt < CACHE_TTL_MS) {
    return cached.phoneNumbers
  }

  const response = await ghlClient.listActivePhoneNumbers({ pageSize: 1000, page: 0, skipNumberPool: false })
  const phoneNumbers = normalizeHighLevelActivePhoneNumbers(response)
  cacheByLocation.set(locationId, { phoneNumbers, savedAt: now })
  return phoneNumbers
}

export function clearHighLevelPhoneNumberCacheForTests() {
  cacheByLocation.clear()
}
