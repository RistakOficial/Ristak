import { setEmailRecipientResolverFactoryForTest } from '../../src/services/emailRecipientService.js'

// Pruebas de envío: el transporte y DNS son fronteras simuladas explícitamente.
// No se consulta el DNS real de los correos de ejemplo ni se envían mensajes.
export function mockRoutableEmailDns() {
  setEmailRecipientResolverFactoryForTest(() => ({
    resolveMx: async () => [{ exchange: 'mail.example.test', priority: 10 }],
    resolve4: async () => ['192.0.2.25'],
    resolve6: async () => []
  }))
}

export function resetEmailRecipientDns() {
  setEmailRecipientResolverFactoryForTest(null)
}
