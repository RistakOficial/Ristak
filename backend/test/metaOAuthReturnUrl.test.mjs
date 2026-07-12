import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMetaOAuthReturnUrl } from '../src/controllers/metaOAuthController.js'

function request({ host = 'tenant.example.com', protocol = 'https', forwardedHost = '', forwardedProto = '' } = {}) {
  const headers = {
    host,
    ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}),
    ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {})
  }
  return {
    headers,
    protocol,
    get(name) {
      return headers[String(name).toLowerCase()]
    }
  }
}

test('Meta OAuth vuelve al dominio público exacto de la instalación', () => {
  const req = request({
    host: 'internal.service:10000',
    forwardedHost: 'raulgomez.onrender.com',
    forwardedProto: 'https'
  })

  assert.equal(
    buildMetaOAuthReturnUrl(req, '/settings/meta-ads/redes-sociales', '/settings/meta-ads/redes-sociales'),
    'https://raulgomez.onrender.com/settings/meta-ads/redes-sociales'
  )
  assert.equal(
    buildMetaOAuthReturnUrl(req, '/settings/meta-ads/ads?source=oauth', '/settings/meta-ads/ads'),
    'https://raulgomez.onrender.com/settings/meta-ads/ads?source=oauth'
  )
})

test('Meta OAuth rechaza retornos externos, protocol-relative y rutas API', () => {
  const req = request({ host: 'tenant.example.com' })
  const fallback = '/settings/meta-ads/redes-sociales'

  for (const unsafe of [
    'https://evil.example/settings/meta',
    '//evil.example/settings/meta',
    '/api/meta/oauth/callback',
    '/settings/meta\\evil',
    '/settings/meta\nother'
  ]) {
    assert.equal(
      buildMetaOAuthReturnUrl(req, unsafe, fallback),
      'https://tenant.example.com/settings/meta-ads/redes-sociales'
    )
  }
})
