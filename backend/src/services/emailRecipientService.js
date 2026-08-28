import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

// Validamos la ruta pública, no la existencia del buzón. No se abren conexiones
// SMTP ni se envía información del contacto a servicios de verificación.
const DNS_DEADLINE_MS = 4000
const CACHE_TTL_MS = 5 * 60 * 1000
const UNKNOWN_CACHE_TTL_MS = 10 * 1000
const MAX_CACHE_ENTRIES = 1000
const MAX_MX_HOSTS = 10
const cache = new Map()
const pending = new Map()
const defaultResolverFactory = () => new Resolver({ timeout: 1500, tries: 1 })
let resolverFactory = defaultResolverFactory

export function setEmailRecipientResolverFactoryForTest(factory) {
  resolverFactory = typeof factory === 'function' ? factory : defaultResolverFactory
  cache.clear()
  pending.clear()
}

function usableAddress(address) {
  let value = String(address || '').toLowerCase()
  if (!isIP(value)) return false
  if (isIP(value) === 6) value = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  if (value === '::' || value === '::1') return false
  if (isIP(value) === 4 || value.startsWith('::ffff:')) {
    const first = isIP(value) === 4
      ? Number(value.split('.')[0])
      : Number.parseInt(value.split(':').at(-2), 16) >>> 8
    return first !== 0 && first !== 127 && first < 224
  }
  return !value.startsWith('ff')
}

const route = (status, reason) => ({ status, reason })
const missingDns = error => ['ENOTFOUND', 'ENODATA'].includes(error?.code)

async function inspectHost(resolver, host) {
  if (isIP(host)) return usableAddress(host)
    ? route('routable', 'mail_route_found')
    : route('unroutable', 'unusable_mail_address')

  const results = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host)
  ])
  const addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (addresses.some(usableAddress)) return route('routable', 'mail_route_found')
  if (results.some(result => result.status === 'rejected' && !missingDns(result.reason))) {
    return route('unknown', 'dns_temporarily_unavailable')
  }
  return route('unroutable', addresses.length ? 'unusable_mail_address' : 'mail_host_not_found')
}

async function inspectDomain(resolver, domain) {
  let records
  try {
    records = await resolver.resolveMx(domain)
  } catch (error) {
    if (error?.code === 'ENOTFOUND') return route('unroutable', 'domain_not_found')
    if (error?.code !== 'ENODATA') return route('unknown', 'dns_temporarily_unavailable')
    records = []
  }

  // Sin MX, SMTP admite A/AAAA como destino implícito. No confundirlo con
  // Null MX ("."), que declara expresamente que el dominio NO recibe correo.
  if (!records.length) return inspectHost(resolver, domain)
  const hosts = [...new Set(records.map(record => String(record.exchange ?? '').trim().toLowerCase().replace(/\.$/, '')))]
    .filter(Boolean)
  if (!hosts.length) return route('unroutable', 'null_mx')

  const results = await Promise.all(hosts.slice(0, MAX_MX_HOSTS).map(host => inspectHost(resolver, host)))
  if (results.some(result => result.status === 'routable')) return route('routable', 'mail_route_found')
  if (results.some(result => result.status === 'unknown') || hosts.length > MAX_MX_HOSTS) {
    return route('unknown', 'dns_temporarily_unavailable')
  }
  return route('unroutable', 'no_usable_mail_server')
}

async function lookupDomain(domain) {
  const cached = cache.get(domain)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  if (pending.has(domain)) return pending.get(domain)

  const lookup = (async () => {
    const resolver = resolverFactory()
    let timer
    try {
      const result = await Promise.race([
        inspectDomain(resolver, domain),
        new Promise(resolve => {
          timer = setTimeout(() => {
            resolve(route('unknown', 'dns_temporarily_unavailable'))
            resolver.cancel?.()
          }, DNS_DEADLINE_MS)
        })
      ])
      cache.delete(domain)
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
      cache.set(domain, {
        result,
        expiresAt: Date.now() + (result.status === 'unknown' ? UNKNOWN_CACHE_TTL_MS : CACHE_TTL_MS)
      })
      return result
    } catch {
      return route('unknown', 'dns_temporarily_unavailable')
    } finally {
      clearTimeout(timer)
    }
  })()
  pending.set(domain, lookup)
  try {
    return await lookup
  } finally {
    pending.delete(domain)
  }
}

export async function assessEmailRecipient(email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { email: normalized, domain: '', ...route('unroutable', 'invalid_email') }
  }
  const domain = domainToASCII(normalized.split('@')[1])
  if (!domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63)) {
    return { email: normalized, domain, ...route('unroutable', 'invalid_email_domain') }
  }
  return { email: normalized, domain, ...await lookupDomain(domain) }
}

export function emailRecipientRouteError(result) {
  const temporary = result.status === 'unknown'
  const error = new Error(temporary
    ? 'No se pudo verificar temporalmente el servidor de correo del destinatario. Intenta de nuevo más tarde.'
    : 'El dominio del destinatario no tiene un servidor de correo válido. Corrige el correo antes de enviarlo.')
  error.status = temporary ? 503 : 400
  error.statusCode = error.status
  error.code = temporary ? 'email_recipient_dns_unavailable' : 'email_recipient_unroutable'
  error.retryable = temporary
  error.reason = result.reason
  return error
}

export async function assertEmailRecipientCanReceive(email) {
  const result = await assessEmailRecipient(email)
  if (result.status !== 'routable') throw emailRecipientRouteError(result)
  return result
}

export async function filterRoutableEmailAttendees(attendees = []) {
  const results = await Promise.all(attendees.map(attendee => assessEmailRecipient(attendee.email)))
  const unknown = results.find(result => result.status === 'unknown')
  // Una caída de DNS aplaza el envío: nunca elimina silenciosamente un invitado
  // válido. Sólo se omiten destinos cuya ruta es demostrablemente imposible.
  if (unknown) throw emailRecipientRouteError(unknown)
  return {
    attendees: attendees.filter((_, index) => results[index].status === 'routable'),
    excluded: results.filter(result => result.status === 'unroutable')
  }
}
