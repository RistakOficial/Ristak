import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applySiteSeoToHtml,
  createSite,
  deleteSite,
  renderPublicSiteHtml,
  updateSite
} from '../src/services/sitesService.js'

const countMatches = (value, pattern) => [...String(value).matchAll(pattern)].length

test('Sites persists every SEO editor field and renders it in the public head', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  let siteId = ''

  try {
    const created = await createSite({
      name: `SEO persistence ${suffix}`,
      slug: `seo-persistence-${suffix}`,
      siteType: 'landing_page',
      title: 'Título anterior',
      description: 'Descripción anterior',
      blankCanvas: true
    })
    siteId = created.id

    const seoFields = {
      seoKeywords: 'automatización, ventas, crm',
      seoAuthor: 'Ristak & Compañía',
      seoImage: '/media/seo-principal.png',
      seoMetaTags: [
        '<meta name="robots" content="index, follow">',
        '<meta property="article:section" content="Ventas & Marketing">',
        '<meta http-equiv="refresh" content="0; url=https://malicioso.test">',
        '<script>alert(1)</script>'
      ].join('\n'),
      seoCanonicalLinks: '/oferta-principal\njavascript:alert(1)',
      seoLanguage: 'pt - Portuguese'
    }
    const updated = await updateSite(siteId, {
      title: 'Título público <Premium>',
      description: 'Descripción pública & lista para buscadores',
      theme: { ...(created.theme || {}), ...seoFields }
    })

    assert.equal(updated.title, 'Título público <Premium>')
    assert.equal(updated.description, 'Descripción pública & lista para buscadores')
    for (const [key, value] of Object.entries(seoFields)) {
      assert.deepEqual(updated.theme[key], value, `theme.${key} debe persistirse`)
    }

    const html = await renderPublicSiteHtml(updated, {
      trackingEnabled: false,
      preview: true,
      publicHost: 'www.ejemplo.test'
    })

    assert.match(html, /<html[^>]* lang="pt">/i)
    assert.match(html, /<title>Título público &lt;Premium&gt;<\/title>/)
    assert.equal(countMatches(html, /<title\b/gi), 1)
    assert.match(html, /<meta name="description" content="Descripción pública &amp; lista para buscadores">/)
    assert.match(html, /<meta name="keywords" content="automatización, ventas, crm">/)
    assert.match(html, /<meta name="author" content="Ristak &amp; Compañía">/)
    assert.match(html, /<meta property="og:image" content="https:\/\/www\.ejemplo\.test\/media\/seo-principal\.png">/)
    assert.match(html, /<meta name="twitter:image" content="https:\/\/www\.ejemplo\.test\/media\/seo-principal\.png">/)
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.ejemplo\.test\/oferta-principal">/)
    assert.match(html, /<meta name="robots" content="index, follow">/)
    assert.match(html, /<meta property="article:section" content="Ventas &amp; Marketing">/)
    assert.doesNotMatch(html, /http-equiv="refresh"/i)
    assert.doesNotMatch(html, /alert\(1\)/)
  } finally {
    if (siteId) await deleteSite(siteId)
  }
})

test('SEO overrides imported head metadata without touching title elements in the body', () => {
  const html = `<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <title>Título viejo</title>
        <meta name="description" content="Descripción vieja">
        <meta property="og:title" content="Open Graph viejo">
        <meta name="robots" content="noindex">
        <link rel="canonical" href="https://viejo.test/ruta">
      </head>
      <body><svg><title>Logo accesible</title></svg></body>
    </html>`
  const site = {
    title: 'Título nuevo',
    description: 'Descripción nueva',
    domain: 'nuevo.test',
    theme: {
      seoLanguage: 'en - English',
      seoMetaTags: '<meta name="robots" content="index, follow">',
      seoCanonicalLinks: '/ruta-nueva'
    }
  }

  const rendered = applySiteSeoToHtml(site, html, { publicHost: 'nuevo.test' })

  assert.match(rendered, /<html[^>]* lang="en">/i)
  assert.match(rendered, /<title>Título nuevo<\/title>/)
  assert.match(rendered, /<svg><title>Logo accesible<\/title><\/svg>/)
  assert.doesNotMatch(rendered, /Título viejo|Descripción vieja|Open Graph viejo|viejo\.test/)
  assert.equal(countMatches(rendered, /<meta name="robots"/gi), 1)
  assert.equal(countMatches(rendered, /<link rel="canonical"/gi), 1)
  assert.match(rendered, /<link rel="canonical" href="https:\/\/nuevo\.test\/ruta-nueva">/)
})
