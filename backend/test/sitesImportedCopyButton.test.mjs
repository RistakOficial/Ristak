import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createImportedSiteFromHtml,
  deleteSite,
  renderPublicSiteHtml
} from '../src/services/sitesService.js'

test('imported HTML keeps declarative copy buttons and injects a safe clipboard runtime', async () => {
  let siteId = ''

  try {
    const sourceHtml = `<!doctype html>
      <html lang="es">
        <head><title>Datos bancarios</title></head>
        <body>
          <label for="clabe">CLABE</label>
          <input id="clabe" readonly value="012164015576527884">
          <button
            type="button"
            data-rstk-copy-value="012164015576527884"
            data-rstk-copy-success-label="Copiado"
            aria-label="Copiar CLABE"
          ><span data-rstk-copy-label>Copiar</span></button>
        </body>
      </html>`

    const created = await createImportedSiteFromHtml({
      name: `HTML copy button ${Date.now()}`,
      filename: 'depositos.html',
      siteType: 'landing_page',
      fileBase64: Buffer.from(sourceHtml, 'utf8').toString('base64')
    })
    siteId = created.site.id

    assert.match(created.import.codeFiles[0].content, /data-rstk-copy-value="012164015576527884"/)
    assert.match(created.import.codeFiles[0].content, /data-rstk-copy-label/)

    const rendered = await renderPublicSiteHtml(created.site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /data-rstk-copy-value="012164015576527884"/)
    assert.match(rendered, /const COPY_BUTTON_SELECTOR = \[/)
    assert.match(rendered, /navigator\.clipboard\.writeText\(cleanValue\)/)
    assert.match(rendered, /document\.execCommand\('copy'\)/)
    assert.match(rendered, /button\.dispatchEvent\(new CustomEvent\('ristak:copied'/)
    assert.match(rendered, /data-rstk-copy-state/)
    assert.match(rendered, /'No se pudo copiar'/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
