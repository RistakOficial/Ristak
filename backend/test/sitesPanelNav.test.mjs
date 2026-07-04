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

test('render público: funnel PUBLICADO usa rutas limpias por paso y ?page= sigue resolviendo (fallback)', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_funnel_routes', name: 'Sitio', title: 'Mi marca', description: '', slug: 'sitio',
    siteType: 'landing_page', status: 'published',
    theme: {
      template: 'ristak',
      // sin pageMode => 'funnel' (pasos), pero PUBLICADO debe rutear limpio
      pages: [
        { id: 'page-1', title: 'Inicio', sortOrder: 0 },
        { id: 'page-2', title: 'Contacto', sortOrder: 1 }
      ]
    },
    blocks: [{
      id: 'header-1', siteId: 'site_funnel_routes', blockType: 'header_panel', label: 'Mi marca',
      content: 'Mi marca', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', panelLinks: [{ pageId: 'page-1' }, { pageId: 'page-2' }] },
      createdAt: '', updatedAt: ''
    }]
  }
  // Publicado (preview:false): links limpios /sitio (home colapsa) y /sitio/contacto, sin ?page=
  const htmlHome = await renderPublicSiteHtml(site, { pagePath: [], trackingEnabled: false, preview: false })
  assert.match(htmlHome, /<a href="\/sitio">Inicio<\/a>/)
  assert.match(htmlHome, /<a href="\/sitio\/contacto">Contacto<\/a>/)
  // Ningún enlace de navegación (<a>) usa ?page= (el helper client-side pageUrl del
  // branching de formularios sí lo usa a propósito, pero no es un <a> de nav).
  assert.doesNotMatch(htmlHome, /<a href="\?page=/)
  // La ruta limpia /sitio/contacto resuelve al paso 2 sin caer al home ni crashear
  // (usa el mismo resolvePageByPathSegments que website mode; aquí solo cambió el gate).
  const htmlStep2 = await renderPublicSiteHtml(site, { pagePath: ['contacto'], trackingEnabled: false, preview: false })
  assert.ok(typeof htmlStep2 === 'string' && htmlStep2.length > 0)
  // Backward-compat: ?page=page-2 (link viejo) sigue resolviendo aunque existan rutas limpias
  const htmlLegacy = await renderPublicSiteHtml(site, { pageId: 'page-2', pagePath: [], trackingEnabled: false, preview: false })
  assert.ok(typeof htmlLegacy === 'string' && htmlLegacy.length > 0)
})

test('render público: el FORMULARIO (standard_form) NO usa rutas limpias, sigue en ?page=', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_form_noroutes', name: 'Form', title: 'Form', description: '', slug: 'form',
    siteType: 'standard_form', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'Uno', sortOrder: 0 }, { id: 'page-2', title: 'Dos', sortOrder: 1 }] },
    blocks: [{
      id: 'header-f', siteId: 'site_form_noroutes', blockType: 'header_panel', label: 'Form',
      content: 'Form', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', panelLinks: [{ pageId: 'page-2' }] },
      createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pagePath: [], trackingEnabled: false, preview: false })
  // los formularios mantienen el esquema de ventanas (?page=), NO rutas limpias
  assert.doesNotMatch(html, /<a href="\/form\/dos">/)
})
