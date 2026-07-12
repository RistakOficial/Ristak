import assert from 'node:assert/strict'
import test from 'node:test'

import { getWhatsAppInteractiveBaseUrl } from '../src/controllers/whatsappApiController.js'

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

test('WhatsApp Embedded Signup vuelve al mismo dominio donde inició el usuario', () => {
  const req = request({
    host: 'internal.service:10000',
    forwardedHost: 'raulgomez.onrender.com',
    forwardedProto: 'https'
  })

  assert.equal(
    getWhatsAppInteractiveBaseUrl(req),
    'https://raulgomez.onrender.com'
  )
})

test('WhatsApp Embedded Signup conserva también un dominio personalizado', () => {
  assert.equal(
    getWhatsAppInteractiveBaseUrl(request({ host: 'app.cliente.com', protocol: 'https' })),
    'https://app.cliente.com'
  )
})
