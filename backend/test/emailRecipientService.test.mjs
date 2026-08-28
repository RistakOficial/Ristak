import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessEmailRecipient,
  assertEmailRecipientCanReceive,
  filterRoutableEmailAttendees,
  setEmailRecipientResolverFactoryForTest
} from '../src/services/emailRecipientService.js'

afterEach(() => setEmailRecipientResolverFactoryForTest(null))
const dnsError = code => Object.assign(new Error(code), { code })
function dnsFixture(overrides = {}) {
  setEmailRecipientResolverFactoryForTest(() => ({
    resolveMx: async () => [{ exchange: 'mail.example.test', priority: 10 }],
    resolve4: async () => ['192.0.2.25'],
    resolve6: async () => [],
    ...overrides
  }))
}

test('bloquea MX imposible como bien.com, Null MX y destinos loopback/unspecified', async () => {
  for (const exchange of ['0.0.0.0.', '.', '', '127.0.0.1', '::', '::1', '0:0:0:0:0:0:0:0', '::ffff:127.0.0.1']) {
    dnsFixture({ resolveMx: async () => [{ exchange, priority: 0 }] })
    const result = await assessEmailRecipient('bien@bien.com')
    assert.equal(result.status, 'unroutable', exchange)
    await assert.rejects(assertEmailRecipientCanReceive('bien@bien.com'), error =>
      error.code === 'email_recipient_unroutable' && error.status === 400 && error.retryable === false)
  }
})

test('un MX con nombre pero resuelto a 0.0.0.0 tampoco recibe invitaciones', async () => {
  dnsFixture({ resolve4: async () => ['0.0.0.0'], resolve6: async () => ['::'] })
  assert.equal((await assessEmailRecipient('cliente@example.test')).status, 'unroutable')
})

test('conserva servidores válidos entre MX mixtos y admite IPv6', async () => {
  dnsFixture({
    resolveMx: async () => [{ exchange: '0.0.0.0.' }, { exchange: 'mail.example.test' }],
    resolve4: async () => { throw dnsError('ENODATA') },
    resolve6: async () => ['2001:db8::25']
  })
  assert.equal((await assessEmailRecipient('cliente@example.test')).status, 'routable')
})

test('sin MX usa A/AAAA; un dominio inexistente se rechaza sin fallback', async () => {
  dnsFixture({ resolveMx: async () => { throw dnsError('ENODATA') } })
  assert.equal((await assessEmailRecipient('cliente@example.test')).status, 'routable')
  let hostLookups = 0
  dnsFixture({
    resolveMx: async () => { throw dnsError('ENOTFOUND') },
    resolve4: async () => { hostLookups++; return ['192.0.2.25'] }
  })
  assert.equal((await assessEmailRecipient('cliente@example.test')).reason, 'domain_not_found')
  assert.equal(hostLookups, 0)
})

test('una caída temporal de DNS aplaza el envío, no elimina al invitado', async () => {
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
    dnsFixture({ resolveMx: async () => { throw dnsError(code) } })
    assert.equal((await assessEmailRecipient('cliente@example.test')).status, 'unknown')
    await assert.rejects(filterRoutableEmailAttendees([{ email: 'cliente@example.test' }]), error =>
      error.code === 'email_recipient_dns_unavailable' && error.status === 503 && error.retryable === true)
  }
  dnsFixture({ resolve4: async () => { throw dnsError('ETIMEOUT') } })
  assert.equal((await assessEmailRecipient('cliente@example.test')).status, 'unknown')
})

test('filtra sólo invitados imposibles y conserva el nombre del invitado válido', async () => {
  dnsFixture({ resolveMx: async domain => [{ exchange: domain === 'bien.com' ? '0.0.0.0.' : 'mail.example.test' }] })
  const good = { email: 'bueno@example.test', displayName: 'Invitado bueno' }
  const result = await filterRoutableEmailAttendees([{ email: 'bien@bien.com' }, good])
  assert.deepEqual(result.attendees, [good])
  assert.equal(result.excluded[0].email, 'bien@bien.com')
})

test('normaliza IDN y comparte caché/consulta concurrente por dominio, no por contacto', async () => {
  const queried = []
  dnsFixture({ resolveMx: async domain => { queried.push(domain); return [{ exchange: 'mail.example.test' }] } })
  const results = await Promise.all([
    assessEmailRecipient('Uno@Mañana.com'), assessEmailRecipient('dos@mañana.com')
  ])
  assert.equal(results.every(result => result.status === 'routable'), true)
  assert.equal(results[0].email, 'uno@mañana.com')
  await assessEmailRecipient('tres@mañana.com')
  assert.deepEqual(queried, ['xn--maana-pta.com'])
})

test('rechaza sintaxis y dominio inválidos sin consultar DNS', async () => {
  dnsFixture({ resolveMx: async () => { assert.fail('No debe consultar DNS') } })
  for (const email of ['sin-arroba', 'a@b', 'a@-host.test', 'a@host..test', 'a@host_test.com']) {
    assert.equal((await assessEmailRecipient(email)).status, 'unroutable')
  }
})

test('el deadline cancela una consulta DNS colgada sin declarar inválido al destinatario', { timeout: 10000 }, async () => {
  let cancelled = false
  dnsFixture({ resolveMx: () => new Promise(() => {}), cancel: () => { cancelled = true } })
  const result = await assessEmailRecipient('cliente@example.test')
  assert.equal(result.status, 'unknown')
  assert.equal(cancelled, true)
})
