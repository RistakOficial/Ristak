import { getAppConfig } from '../config/database.js'

export const ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY = 'account_business_profile'

export const DEFAULT_ACCOUNT_BUSINESS_PROFILE = {
  logoUrl: '',
  name: '',
  email: '',
  phone: '',
  address: '',
  website: '',
  terms: ''
}

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function parseStoredProfile(rawValue) {
  if (!rawValue) return {}
  if (typeof rawValue === 'object') return rawValue

  try {
    const parsed = JSON.parse(rawValue)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function normalizeAccountBusinessProfile(input = {}) {
  const profile = input && typeof input === 'object' ? input : {}

  return {
    logoUrl: cleanString(profile.logoUrl || profile.logo_url, 1000),
    name: cleanString(profile.name || profile.businessName || profile.business_name, 160),
    email: cleanString(profile.email || profile.businessEmail || profile.business_email, 160),
    phone: cleanString(profile.phone || profile.businessPhone || profile.business_phone, 80),
    address: cleanString(profile.address || profile.businessAddress || profile.business_address, 500),
    website: cleanString(profile.website || profile.businessWebsite || profile.business_website, 250),
    terms: cleanString(profile.terms || profile.paymentTerms || profile.payment_terms, 12000)
  }
}

export function hasAccountBusinessProfileDetails(profile = {}) {
  const normalized = normalizeAccountBusinessProfile(profile)
  return Object.values(normalized).some(Boolean)
}

export async function getAccountBusinessProfile() {
  const stored = parseStoredProfile(await getAppConfig(ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY))
  return normalizeAccountBusinessProfile(stored)
}
