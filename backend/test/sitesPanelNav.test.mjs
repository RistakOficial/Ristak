import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePanelNavLinks } from '../../shared/sites/renderContract.js'

test('resolvePanelNavLinks: un enlace a página usa el título vivo como label', () => {
  const pages = [{ id: 'p1', title: 'Inicio' }, { id: 'p2', title: 'Contacto' }]
  const out = resolvePanelNavLinks([{ pageId: 'p1' }, { pageId: 'p2' }], pages)
  assert.deepEqual(out, [
    { label: 'Inicio', url: '', pageId: 'p1' },
    { label: 'Contacto', url: '', pageId: 'p2' }
  ])
})

test('resolvePanelNavLinks: descarta enlaces a páginas inexistentes (el bug)', () => {
  const pages = [{ id: 'p1', title: 'Inicio' }]
  const out = resolvePanelNavLinks([{ pageId: 'p1' }, { pageId: 'ghost' }], pages)
  assert.equal(out.length, 1)
  assert.equal(out[0].pageId, 'p1')
})

test('resolvePanelNavLinks: conserva enlaces libres (URL/ancla) sin pageId', () => {
  const out = resolvePanelNavLinks([{ label: 'WhatsApp', url: 'https://wa.me/1' }, { label: 'Form', url: '#form' }], [])
  assert.deepEqual(out, [
    { label: 'WhatsApp', url: 'https://wa.me/1', pageId: '' },
    { label: 'Form', url: '#form', pageId: '' }
  ])
})

test('resolvePanelNavLinks: label explícito pisa el título de la página', () => {
  const pages = [{ id: 'p1', title: 'Página principal' }]
  const out = resolvePanelNavLinks([{ pageId: 'p1', label: 'Inicio' }], pages)
  assert.equal(out[0].label, 'Inicio')
})

test('resolvePanelNavLinks: formato legacy "label | url" y objetos mezclados', () => {
  const out = resolvePanelNavLinks(['Inicio | #', { pageId: 'p1' }], [{ id: 'p1', title: 'Contacto' }])
  assert.deepEqual(out, [
    { label: 'Inicio', url: '#', pageId: '' },
    { label: 'Contacto', url: '', pageId: 'p1' }
  ])
})

test('resolvePanelNavLinks: entrada no-array o vacía devuelve []', () => {
  assert.deepEqual(resolvePanelNavLinks(undefined, []), [])
  assert.deepEqual(resolvePanelNavLinks(null, [{ id: 'p1', title: 'x' }]), [])
  assert.deepEqual(resolvePanelNavLinks([{ label: '' }], []), [])
})

test('render público: el header_panel enlaza a páginas reales con ?page= y descarta fantasmas', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_panel', name: 'Sitio', title: 'Mi marca', description: '', slug: 'sitio',
    siteType: 'landing_page', status: 'published',
    theme: {
      template: 'ristak',
      pages: [
        { id: 'page-1', title: 'Inicio', sortOrder: 0 },
        { id: 'page-2', title: 'Contacto', sortOrder: 1 }
      ]
    },
    blocks: [{
      id: 'header-1', siteId: 'site_panel', blockType: 'header_panel', label: 'Mi marca',
      content: 'Mi marca', options: [], sortOrder: 0,
      settings: {
        pageId: 'page-1',
        panelLinks: [
          { pageId: 'page-1' },
          { pageId: 'page-2' },
          { pageId: 'ghost-999' },
          { label: 'WhatsApp', url: 'https://wa.me/1' }
        ]
      },
      createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  // enlaces a página reales -> ?page= con su título como texto
  assert.match(html, /<a href="\?page=page-1">Inicio<\/a>/)
  assert.match(html, /<a href="\?page=page-2">Contacto<\/a>/)
  // el enlace personalizado se conserva
  assert.match(html, /<a href="https:\/\/wa\.me\/1">WhatsApp<\/a>/)
  // la página fantasma NO aparece
  assert.doesNotMatch(html, /ghost-999/)
})
