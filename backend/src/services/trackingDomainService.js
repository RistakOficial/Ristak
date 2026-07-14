import { getAppConfig, setAppConfig } from '../config/database.js'
import { normalizeDomain, verifyPublicDomainConnection } from './sitesService.js'

export const TRACKING_DOMAIN_CONFIG_KEYS = Object.freeze({
  domain: 'tracking_domain',
  verified: 'tracking_domain_verified',
  checkedAt: 'tracking_domain_checked_at',
  error: 'tracking_domain_error'
})

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function buildDomainState(domain, verification, checkedAt = new Date().toISOString()) {
  return {
    trackingDomain: domain,
    trackingDomainVerified: Boolean(verification.verified),
    trackingDomainCheckedAt: checkedAt,
    trackingDomainError: verification.verified
      ? null
      : verification.error || 'Dominio no conectado a esta app'
  }
}

export async function getTrackingDomainConfig() {
  const [rawDomain, verified, checkedAt, error] = await Promise.all([
    getAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.domain),
    getAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.verified),
    getAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.checkedAt),
    getAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.error)
  ])
  const trackingDomain = normalizeDomain(rawDomain)

  return {
    trackingDomain,
    trackingDomainVerified: Boolean(trackingDomain && cleanString(verified) === '1'),
    trackingDomainCheckedAt: cleanString(checkedAt) || null,
    trackingDomainError: cleanString(error) || null
  }
}

async function saveTrackingDomainVerification(domain, verification, checkedAt) {
  const state = buildDomainState(domain, verification, checkedAt)

  await Promise.all([
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.domain, state.trackingDomain),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.verified, state.trackingDomainVerified ? '1' : '0'),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.checkedAt, state.trackingDomainCheckedAt),
    setAppConfig(TRACKING_DOMAIN_CONFIG_KEYS.error, state.trackingDomainError)
  ])

  return state
}

export async function verifyAndSaveTrackingDomain(domainValue) {
  const current = await getTrackingDomainConfig()
  const rawDomain = cleanString(domainValue)
  const domain = normalizeDomain(rawDomain)
  const checkedAt = new Date().toISOString()

  if (!domain) {
    const verification = {
      verified: false,
      error: rawDomain ? 'Dominio inválido' : 'Escribe un dominio primero'
    }
    return {
      ...current,
      candidate: buildDomainState(rawDomain, verification, checkedAt),
      verification
    }
  }

  const verification = await verifyPublicDomainConnection(domain)
  const candidate = buildDomainState(domain, verification, checkedAt)

  // Un dominio nuevo sólo sustituye al actual cuando ya comprobamos que llega a
  // esta instalación. Si estamos revalidando el actual, sí guardamos el fallo
  // para no seguir entregando un pixel con un dominio que dejó de responder.
  const shouldPersist = verification.verified || domain === current.trackingDomain
  const next = shouldPersist
    ? await saveTrackingDomainVerification(domain, verification, checkedAt)
    : current

  return {
    ...next,
    candidate,
    verification
  }
}
