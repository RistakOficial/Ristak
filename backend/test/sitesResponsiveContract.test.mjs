import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveDeviceBlockSettings,
  resolveBlockVisibility,
  buildBlockResponsiveCss,
  buildBlocksResponsiveCss,
  buildBlockStyleClassName,
  blockHasStyleWrapper,
  buildBlockStyleVars,
  RESPONSIVE_DEVICE_MAX_WIDTH
} from '../../shared/sites/renderContract.js'

test('visibilidad por dispositivo nace activa y conserva compatibilidad con hidden', () => {
  assert.deepEqual(resolveBlockVisibility({ settings: {} }), { desktop: true, mobile: true })
  assert.deepEqual(resolveBlockVisibility({ settings: { hidden: true } }), { desktop: false, mobile: false })
  assert.deepEqual(resolveBlockVisibility({ settings: { hidden: 'true' } }), { desktop: false, mobile: false })
  assert.deepEqual(resolveBlockVisibility({
    settings: { visibleOnDesktop: true, visibleOnMobile: false, hidden: false }
  }), { desktop: true, mobile: false })
})

test('visibilidad por dispositivo genera CSS público y conserva wrapper editable', () => {
  const desktopOnly = {
    id: 'desktop-only',
    blockType: 'text',
    settings: { visibleOnDesktop: true, visibleOnMobile: false }
  }
  assert.match(buildBlockResponsiveCss(desktopOnly, { queryType: 'media' }), /@media \(max-width:640px\).*display:none!important/)
  assert.equal(buildBlockResponsiveCss(desktopOnly, { queryType: 'container' }), '')
  assert.match(buildBlockStyleClassName(desktopOnly), /rstkDeviceMobileHidden/)
  assert.equal(blockHasStyleWrapper(desktopOnly), true)

  const mobileOnly = {
    id: 'mobile-only',
    blockType: 'text',
    settings: { visibleOnDesktop: false, visibleOnMobile: true }
  }
  assert.match(buildBlockResponsiveCss(mobileOnly, { queryType: 'media' }), /@media \(min-width:641px\).*display:none!important/)
  assert.match(buildBlockStyleClassName(mobileOnly), /rstkDeviceDesktopHidden/)
})

test('resolveDeviceBlockSettings aplica la cascada desktop -> tablet -> mobile', () => {
  const settings = {
    fontSize: 30,
    blockPaddingTop: 40,
    responsive: {
      tablet: { fontSize: 24 },
      mobile: { fontSize: 18 }
    }
  }
  // desktop = base intacto
  assert.equal(resolveDeviceBlockSettings(settings, 'desktop').fontSize, 30)
  assert.equal(resolveDeviceBlockSettings(settings, 'desktop').blockPaddingTop, 40)
  // tablet hereda desktop y pisa fontSize
  const tablet = resolveDeviceBlockSettings(settings, 'tablet')
  assert.equal(tablet.fontSize, 24)
  assert.equal(tablet.blockPaddingTop, 40)
  // mobile hereda desktop+tablet y pisa fontSize
  const mobile = resolveDeviceBlockSettings(settings, 'mobile')
  assert.equal(mobile.fontSize, 18)
  assert.equal(mobile.blockPaddingTop, 40)
})

test('mobile hereda del override de tablet cuando no define la propiedad', () => {
  const settings = {
    fontSize: 30,
    responsive: { tablet: { fontSize: 22 }, mobile: { blockRadius: 8 } }
  }
  const mobile = resolveDeviceBlockSettings(settings, 'mobile')
  assert.equal(mobile.fontSize, 22) // heredado de tablet
  assert.equal(mobile.blockRadius, 8) // propio de mobile
})

test('sin settings.responsive el resolver devuelve el base sin tocar (retrocompat)', () => {
  const settings = { fontSize: 20 }
  assert.deepEqual(resolveDeviceBlockSettings(settings, 'mobile'), { fontSize: 20 })
  assert.deepEqual(resolveDeviceBlockSettings(settings, 'tablet'), { fontSize: 20 })
})

test('buildBlockResponsiveCss no emite nada sin overrides (aditivo / cero riesgo)', () => {
  const block = { id: 'b1', blockType: 'text', settings: { fontSize: 20 } }
  assert.equal(buildBlockResponsiveCss(block, { queryType: 'media' }), '')
  assert.equal(buildBlockResponsiveCss({ id: 'b2', blockType: 'text', settings: {} }, {}), '')
})

test('buildBlockResponsiveCss (media) emite solo las variables que cambian, por breakpoint', () => {
  const block = {
    id: 'b1',
    blockType: 'text',
    settings: { fontSize: 30, responsive: { mobile: { fontSize: 16 } } }
  }
  const css = buildBlockResponsiveCss(block, { queryType: 'media' })
  // fontSize -> --rstk-block-size (verificado contra buildBlockStyleVars)
  const mobileVars = buildBlockStyleVars({ ...block, settings: { fontSize: 16 } })
  assert.ok(mobileVars['--rstk-block-size'] === '16px')
  assert.match(css, /@media \(max-width:640px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:16px!important\}\}/)
  // no incluye tablet (no hay override de tablet)
  assert.doesNotMatch(css, /max-width:1024px/)
})

test('buildBlockResponsiveCss (container) usa @container rstk-canvas para el editor', () => {
  const block = {
    id: 'b1',
    blockType: 'text',
    settings: { fontSize: 30, responsive: { tablet: { fontSize: 24 }, mobile: { fontSize: 16 } } }
  }
  const css = buildBlockResponsiveCss(block, { queryType: 'container' })
  assert.match(css, /@container rstk-canvas \(max-width:1024px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:24px!important\}\}/)
  assert.match(css, /@container rstk-canvas \(max-width:640px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:16px!important\}\}/)
})

test('un override igual al desktop no emite nada (diff vacío)', () => {
  const block = {
    id: 'b1',
    blockType: 'text',
    settings: { fontSize: 20, responsive: { mobile: { fontSize: 20 } } }
  }
  assert.equal(buildBlockResponsiveCss(block, { queryType: 'media' }), '')
})

test('buildBlocksResponsiveCss concatena solo los bloques con overrides', () => {
  const blocks = [
    { id: 'b1', blockType: 'text', settings: { fontSize: 30, responsive: { mobile: { fontSize: 16 } } } },
    { id: 'b2', blockType: 'text', settings: { fontSize: 20 } },
    { id: 'b3', blockType: 'image', settings: { mediaWidth: 100, responsive: { mobile: { mediaWidth: 60 } } } }
  ]
  const css = buildBlocksResponsiveCss(blocks, { queryType: 'media' })
  assert.match(css, /\[data-rstk-block-id="b1"\]/)
  assert.doesNotMatch(css, /\[data-rstk-block-id="b2"\]/)
  assert.match(css, /\[data-rstk-block-id="b3"\]\{--rstk-media-width:60%!important\}/)
})

test('breakpoints declarados', () => {
  assert.equal(RESPONSIVE_DEVICE_MAX_WIDTH.tablet, 1024)
  assert.equal(RESPONSIVE_DEVICE_MAX_WIDTH.mobile, 640)
})

test('contraste de texto grande: los títulos usan umbral 3.0 (WCAG large text)', () => {
  const ctx = { site: { theme: { backgroundColor: '#0f0f10' } }, pageBg: '#0f0f10' }
  const b = (blockType, blockText) => ({ id: 'x', blockType, label: 'T', content: 'T', options: [], settings: { blockText } })
  // #ff3366 sobre oscuro tiene contraste ~3.86: pasa 3.0 (título) pero no 4.5 (texto normal).
  assert.equal(buildBlockStyleVars(b('title', '#ff3366'), ctx)['--rstk-block-text'], '#ff3366', 'el título conserva el color legible como large text')
  assert.equal(buildBlockStyleVars(b('hero', '#ff3366'), ctx)['--rstk-block-text'], '#ff3366', 'el hero también')
  // un color realmente ilegible (contraste ~1.3) sí se voltea, incluso en título
  assert.equal(buildBlockStyleVars(b('title', '#333333'), ctx)['--rstk-block-text'], '#f4f4f6', 'color ilegible sí se corrige')
  // un texto grande por fontSize>=24 aunque no sea tipo heading
  const bigText = { id: 'y', blockType: 'text', label: 'T', content: 'T', options: [], settings: { blockText: '#ff3366', fontSize: 28 } }
  assert.equal(buildBlockStyleVars(bigText, ctx)['--rstk-block-text'], '#ff3366', 'texto con fontSize>=24 cuenta como large text')
})

test('render público: un bloque con override responsive emite @media + wrapper con data-rstk-block-id', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_responsive', name: 'R', title: 'R', description: '', slug: 'r',
    siteType: 'landing_page', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [{
      id: 'title-1', siteId: 'site_responsive', blockType: 'title', label: 'T',
      content: 'Título', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', fontSize: 40, responsive: { mobile: { fontSize: 22 } } },
      createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  // el bloque recibe wrapper con su id (para que el CSS por dispositivo lo alcance)
  assert.match(html, /data-rstk-block-id="title-1"/)
  // y el override responsive va en un @media 640
  assert.match(html, /<style data-rstk-responsive>/)
  assert.match(html, /@media \(max-width:640px\)\{\[data-rstk-block-id="title-1"\]\{--rstk-block-size:22px!important\}\}/)
})

test('render público: sitio SIN responsive no emite el style de responsive (retrocompat)', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_plain', name: 'P', title: 'P', description: '', slug: 'p',
    siteType: 'landing_page', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [{
      id: 'title-1', siteId: 'site_plain', blockType: 'title', label: 'T',
      content: 'Título', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', fontSize: 40 }, createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.doesNotMatch(html, /data-rstk-responsive/)
})

test('render público: bloque solo escritorio se oculta en celular y mantiene su identidad', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_visibility', name: 'V', title: 'V', description: '', slug: 'v',
    siteType: 'landing_page', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [{
      id: 'desktop-title', siteId: 'site_visibility', blockType: 'title', label: 'T',
      content: 'Solo escritorio', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', visibleOnDesktop: true, visibleOnMobile: false },
      createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /class="[^"]*rstkDeviceMobileHidden[^"]*" data-rstk-block-id="desktop-title"/)
  assert.match(html, /@media \(max-width:640px\)\{\[data-rstk-block-id="desktop-title"\]\{display:none!important\}\}/)
})

test('render público: ambos dispositivos apagados equivalen a oculto global', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_hidden', name: 'H', title: 'H', description: '', slug: 'h',
    siteType: 'landing_page', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [{
      id: 'hidden-title', siteId: 'site_hidden', blockType: 'title', label: 'T',
      content: 'Oculto', options: [], sortOrder: 0,
      settings: { pageId: 'page-1', visibleOnDesktop: false, visibleOnMobile: false },
      createdAt: '', updatedAt: ''
    }]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /data-rstk-user-hidden="true" hidden aria-hidden="true"/)
  assert.match(html, /\[data-rstk-block-id="hidden-title"\]\{display:none!important\}/)
})
