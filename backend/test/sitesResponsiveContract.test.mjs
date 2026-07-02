import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveDeviceBlockSettings,
  buildBlockResponsiveCss,
  buildBlocksResponsiveCss,
  buildBlockStyleVars,
  RESPONSIVE_DEVICE_MAX_WIDTH
} from '../../shared/sites/renderContract.js'

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
  assert.match(css, /@media \(max-width:640px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:16px\}\}/)
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
  assert.match(css, /@container rstk-canvas \(max-width:1024px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:24px\}\}/)
  assert.match(css, /@container rstk-canvas \(max-width:640px\)\{\[data-rstk-block-id="b1"\]\{--rstk-block-size:16px\}\}/)
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
  assert.match(css, /\[data-rstk-block-id="b3"\]\{--rstk-media-width:60%\}/)
})

test('breakpoints declarados', () => {
  assert.equal(RESPONSIVE_DEVICE_MAX_WIDTH.tablet, 1024)
  assert.equal(RESPONSIVE_DEVICE_MAX_WIDTH.mobile, 640)
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
  assert.match(html, /@media \(max-width:640px\)\{\[data-rstk-block-id="title-1"\]\{--rstk-block-size:22px\}\}/)
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
