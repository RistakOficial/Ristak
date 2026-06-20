import test from 'node:test'
import assert from 'node:assert/strict'

import { createSite, deleteSite, renderPublicSiteHtml } from '../src/services/sitesService.js'

const uniqueSlug = (prefix, template) => `${prefix}-${template}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const LANDING_TEMPLATES = [
  { template: 'ristak', expected: ['conversaciones listas para cerrar', 'Senales de confianza'] },
  { template: 'executive', expected: ['propuesta profesional', 'Diagnostico ejecutivo'] },
  { template: 'launch', expected: ['pagina que se siente lista para vender', 'Cuenta regresiva'] },
  { template: 'premium', expected: ['oferta de alto valor', 'llamada privada'] },
  { template: 'local', expected: ['contacten tu negocio', 'Preguntas frecuentes'] },
  { template: 'vsl', expected: ['oferta que se entiende', 'bajan la duda'] },
  { template: 'facebook', expected: ['Sigue esta oferta', 'contexto'] },
  { template: 'instagram', expected: ['Sigue esta oferta', 'contexto'] },
  { template: 'tiktok', expected: ['Sigue esta oferta', 'contexto'] }
]

const STANDARD_FORM_TEMPLATES = [
  { template: 'compact', expected: ['Deja tus datos y te respondemos'] },
  { template: 'event', expected: ['Reserva tu lugar'] },
  { template: 'quote', expected: ['Cuentanos que necesitas cotizar'] },
  { template: 'callback', expected: ['Solicita una llamada consultiva'] },
  { template: 'waitlist', expected: ['Entra a la lista prioritaria'] },
  { template: 'facebook', expected: ['seguimos por mensaje'] },
  { template: 'instagram', expected: ['seguimos por mensaje'] },
  { template: 'tiktok', expected: ['seguimos por mensaje'] },
  { template: 'ristak', expected: ['Solicita informacion'] },
  { template: 'executive', expected: ['Solicita informacion'] },
  { template: 'local', expected: ['Solicita informacion'] },
  { template: 'premium', expected: ['Solicita informacion'] }
]

const INTERACTIVE_TEMPLATES = [
  { template: 'interactive', expected: ['Vamos paso a paso'] },
  { template: 'callback', expected: ['preparamos una llamada'] },
  { template: 'quote', expected: ['Cotiza sin vueltas'] },
  { template: 'event', expected: ['Confirma tu registro'] },
  { template: 'waitlist', expected: ['lista prioritaria'] },
  { template: 'facebook', expected: ['seguimos por mensaje'] },
  { template: 'instagram', expected: ['seguimos por mensaje'] },
  { template: 'tiktok', expected: ['seguimos por mensaje'] }
]

async function createTemplateSite(siteType, template, prefix) {
  return createSite({
    name: `${prefix} ${template}`,
    slug: uniqueSlug(prefix, template),
    siteType,
    status: 'draft',
    theme: { template }
  })
}

async function assertTemplateCreatesRenderableSite(siteType, template, expected, prefix) {
  let site
  try {
    site = await createTemplateSite(siteType, template, prefix)
    assert.ok(site.id)
    assert.equal(site.theme?.template, template)
    assert.ok((site.blocks || []).length >= 2, `${template} should create default blocks`)

    const html = await renderPublicSiteHtml(site, {
      trackingEnabled: false,
      preview: true
    })

    for (const text of expected) {
      assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  } finally {
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
  }
}

test('template library creates polished landing defaults for every landing template', async () => {
  for (const { template, expected } of LANDING_TEMPLATES) {
    await assertTemplateCreatesRenderableSite('landing_page', template, expected, 'landing-template')
  }
})

test('template library creates polished standard form defaults for every form template', async () => {
  for (const { template, expected } of STANDARD_FORM_TEMPLATES) {
    await assertTemplateCreatesRenderableSite('standard_form', template, expected, 'form-template')
  }
})

test('template library creates polished interactive defaults for every guided template', async () => {
  for (const { template, expected } of INTERACTIVE_TEMPLATES) {
    await assertTemplateCreatesRenderableSite('interactive_form', template, expected, 'interactive-template')
  }
})
