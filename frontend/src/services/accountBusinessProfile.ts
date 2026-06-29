export const ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY = 'account_business_profile'

export interface AccountBusinessProfile {
  logoUrl: string
  name: string
  email: string
  phone: string
  address: string
  website: string
  terms: string
}

export const defaultAccountBusinessProfile: AccountBusinessProfile = {
  logoUrl: '',
  name: '',
  email: '',
  phone: '',
  address: '',
  website: '',
  terms: ''
}

const cleanString = (value: unknown, maxLength = 500) => String(value || '').trim().slice(0, maxLength)

export function normalizeAccountBusinessProfile(input?: Partial<AccountBusinessProfile> | null): AccountBusinessProfile {
  const profile = input && typeof input === 'object' ? input : {}

  return {
    logoUrl: cleanString(profile.logoUrl, 1000),
    name: cleanString(profile.name, 160),
    email: cleanString(profile.email, 160),
    phone: cleanString(profile.phone, 80),
    address: cleanString(profile.address, 500),
    website: cleanString(profile.website, 250),
    terms: cleanString(profile.terms, 12000)
  }
}

export function hasAccountBusinessProfileDetails(profile?: Partial<AccountBusinessProfile> | null) {
  return Object.values(normalizeAccountBusinessProfile(profile)).some(Boolean)
}
