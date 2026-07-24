import { db } from '../config/database.js'
import { getManagedOwnerEmail } from './licenseService.js'

const PREMIUM_MEDIA_OWNER_EMAILS = new Set([
  'milemedia.mkt@gmail.com'
])

const STANDARD_MEDIA_POLICY = Object.freeze({
  id: 'standard',
  unlimitedQuota: false,
  unlimitedDirectVideoUpload: false,
  preserveVideoSource: false,
  premiumStream: false,
  streamProfile: 'standard'
})

const PREMIUM_MEDIA_POLICY = Object.freeze({
  id: 'owner_premium_media',
  unlimitedQuota: true,
  unlimitedDirectVideoUpload: true,
  preserveVideoSource: true,
  premiumStream: true,
  streamProfile: 'premium_adaptive_v1',
  streamLibraryName: 'Ristak Sites Premium Adaptive',
  streamCollectionName: 'Ristak Sites Premium'
})

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase()
}

export function mediaAccountPolicyForOwnerEmail(email = '') {
  return PREMIUM_MEDIA_OWNER_EMAILS.has(normalizeEmail(email))
    ? PREMIUM_MEDIA_POLICY
    : STANDARD_MEDIA_POLICY
}

export async function resolveMediaAccountPolicy() {
  const managedOwnerEmail = normalizeEmail(getManagedOwnerEmail())
  if (managedOwnerEmail) return mediaAccountPolicyForOwnerEmail(managedOwnerEmail)

  const premiumAdmin = await db.get(
    `SELECT email
     FROM users
     WHERE role = 'admin'
       AND is_active = 1
       AND email IS NOT NULL
       AND TRIM(email) != ''
       AND LOWER(TRIM(email)) = ?
     ORDER BY id ASC
     LIMIT 1`,
    [[...PREMIUM_MEDIA_OWNER_EMAILS][0]]
  ).catch(() => null)

  return mediaAccountPolicyForOwnerEmail(premiumAdmin?.email)
}
