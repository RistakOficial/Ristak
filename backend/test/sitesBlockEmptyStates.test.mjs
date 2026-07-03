import test from 'node:test'
import assert from 'node:assert/strict'

const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')

function siteWith(block) {
  return {
    id: 'site_x', name: 'S', title: 'S', description: '', slug: 's',
    siteType: 'landing_page', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [{ id: 'b1', siteId: 'site_x', options: [], sortOrder: 0, createdAt: '', updatedAt: '', settings: { pageId: 'page-1' }, ...block }]
  }
}

async function renderBlock(block) {
  return renderPublicSiteHtml(siteWith(block), { pageId: 'page-1', trackingEnabled: false, preview: true })
}

test('imagen sin URL: el publicado usa el mock (marco punteado + ícono), no el texto pelón viejo', async () => {
  const html = await renderBlock({ blockType: 'image', label: 'Imagen', content: '', settings: { pageId: 'page-1' } })
  assert.match(html, /rstk-media-empty rstk-media-empty-mock/)
  assert.match(html, /rstk-media-empty-icon/)
  assert.match(html, /Agrega una imagen/)
  assert.doesNotMatch(html, /Imagen sin URL/)
})

test('video sin URL: el publicado usa el mock 16:9 con el círculo de play', async () => {
  const html = await renderBlock({ blockType: 'video', label: 'Video', content: '', settings: { pageId: 'page-1' } })
  assert.match(html, /rstk-media-empty-mock rstk-media-empty-video/)
  assert.match(html, /rstk-play/)
  assert.match(html, /Agrega la URL del video/)
})

test('las reglas CSS del mock viven en la hoja compartida (aplican al publicado)', async () => {
  const html = await renderBlock({ blockType: 'image', label: 'Imagen', content: '', settings: { pageId: 'page-1' } })
  assert.match(html, /\.rstk-media-empty-mock\{/)
})

test('footer_panel: los saltos de línea del copy se publican como <br>', async () => {
  const html = await renderBlock({ blockType: 'footer_panel', label: 'Pie', content: 'Línea uno\nLínea dos', settings: { pageId: 'page-1' } })
  assert.match(html, /Línea uno<br>Línea dos/)
})

test('testimonials sin título ni nombre interno: no se emite <h2></h2> vacío', async () => {
  const html = await renderBlock({ blockType: 'testimonials', label: '', content: '', settings: { pageId: 'page-1', items: [{ title: 'Ana', text: 'Genial' }] } })
  assert.doesNotMatch(html, /<h2><\/h2>/)
  assert.match(html, /rstk-list-grid/)
})

test('testimonials con título: sí emite el <h2>', async () => {
  const html = await renderBlock({ blockType: 'testimonials', label: 'Reseñas', content: 'Lo que dicen', settings: { pageId: 'page-1', items: [{ title: 'Ana', text: 'Genial' }] } })
  assert.match(html, /<h2>Lo que dicen<\/h2>/)
})
