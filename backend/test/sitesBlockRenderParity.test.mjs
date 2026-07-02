import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

// Paridad de bloques (Paquete C): el HTML publicado consume el contrato
// compartido (buildBlockStyleVars / buildBlockStyleClassName) y los fixes
// deliberados de content #5/#9/#12 y form-fields #5/#6.

let siteCounter = 0

const makeSite = (blocks, { siteType = 'standard_form' } = {}) => {
  const id = `site_block_parity_${++siteCounter}`
  return {
    id,
    name: 'Sitio de paridad',
    title: 'Sitio de paridad',
    description: '',
    slug: `paridad-${siteCounter}`,
    siteType,
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: blocks.map((block, index) => ({
      id: block.id || `block-${index + 1}`,
      siteId: id,
      label: '',
      content: '',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: index,
      createdAt: '',
      updatedAt: '',
      ...block,
      settings: { pageId: 'page-1', ...(block.settings || {}) }
    }))
  }
}

const render = (blocks, options = {}) =>
  renderPublicSiteHtml(makeSite(blocks, options), { pageId: 'page-1', trackingEnabled: false, preview: true })

test('embed con URL de Wistia publica el player oficial (content #9 / embeds #17)', async () => {
  const html = await render([
    { blockType: 'embed', label: 'Embed', content: 'https://miempresa.wistia.com/medias/abc123' }
  ])
  assert.match(html, /<iframe class="rstk-embed" src="https:\/\/fast\.wistia\.net\/embed\/iframe\/abc123"/)
})

test('embed con snippet de script de Wistia también publica el player (content #9)', async () => {
  const html = await render([
    { blockType: 'embed', label: 'Embed', content: '<script src="https://fast.wistia.com/embed/def456.js" async></script>' }
  ])
  assert.match(html, /<iframe class="rstk-embed" src="https:\/\/fast\.wistia\.net\/embed\/iframe\/def456"/)
})

test('saltos de línea de título/subtítulo publican <br> (content #5)', async () => {
  const html = await render([
    { blockType: 'title', label: 'Título', content: 'Línea uno\nLínea dos' },
    { blockType: 'subtitle', label: 'Subtítulo', content: 'Sub uno\nSub dos' }
  ])
  assert.match(html, /<h1 class="rstk-headline">Línea uno<br>Línea dos<\/h1>/)
  assert.match(html, /<p class="rstk-subheading">Sub uno<br>Sub dos<\/p>/)
})

test('el título del contador también publica <br> (content #5)', async () => {
  const html = await render([
    { blockType: 'countdown', label: 'Contador', content: 'Termina\npronto', settings: { countdownMode: 'duration' } }
  ])
  assert.match(html, /<p class="rstk-countdown-title">Termina<br>pronto<\/p>/)
})

test('dropdown publica block.placeholder como primera opción (form-fields #6)', async () => {
  const withPlaceholder = await render([
    {
      blockType: 'dropdown',
      label: 'Pregunta',
      placeholder: 'Elige tu plan',
      options: [{ id: 'a', label: 'Opción A', value: 'a', action: 'continue' }]
    }
  ])
  assert.match(withPlaceholder, /<option value="">Elige tu plan<\/option>/)

  const withoutPlaceholder = await render([
    {
      blockType: 'dropdown',
      label: 'Pregunta',
      options: [{ id: 'a', label: 'Opción A', value: 'a', action: 'continue' }]
    }
  ])
  assert.match(withoutPlaceholder, /<option value="">Selecciona una opción<\/option>/)
})

test('campo con fieldWidth publica wrapper con rstk-field-width-set + variable (form-fields #5)', async () => {
  const html = await render([
    { blockType: 'short_text', label: 'Nombre', settings: { fieldWidth: 60 } }
  ])
  const wrapper = html.match(/<div class="([^"]*rstk-block-style[^"]*)"[^>]*style="([^"]*)"/)
  assert.ok(wrapper, 'se espera el wrapper estilizado')
  assert.ok(wrapper[1].includes('rstk-field-width-set'))
  assert.ok(wrapper[2].includes('--rstk-field-width:60%'))
})

test('campo estilizado SIN fieldWidth no emite rstk-field-width-set (form-fields #5)', async () => {
  const html = await render([
    { blockType: 'short_text', label: 'Nombre', settings: { blockText: '#111827' } }
  ])
  const wrapper = html.match(/<div class="([^"]*rstk-block-style[^"]*)"/)
  assert.ok(wrapper, 'se espera el wrapper estilizado')
  assert.ok(!wrapper[1].includes('rstk-field-width-set'))
})

test('un bloque sin settings de estilo NO se envuelve en rstk-block-style (content #3)', async () => {
  const html = await render([
    { blockType: 'title', label: 'Título', content: 'Hola' }
  ])
  assert.match(html, /<h1 class="rstk-headline">Hola<\/h1>/)
  // El wrapper publicado siempre lleva data-rstk-block-id; sin estilos no existe.
  assert.ok(!html.includes('data-rstk-block-id="block-1"'), 'sin estilos no debe haber wrapper de bloque')
})

test('countdown: countdownShowLabels string "false" oculta etiquetas (content #12)', async () => {
  const withLabels = await render([
    { blockType: 'countdown', label: 'Contador', settings: { countdownMode: 'duration' } }
  ])
  assert.match(withLabels, /<span>Días<\/span>/)

  const withoutLabels = await render([
    { blockType: 'countdown', label: 'Contador', settings: { countdownMode: 'duration', countdownShowLabels: 'false' } }
  ])
  assert.ok(!/<span>Días<\/span>/.test(withoutLabels))
})

test('countdown por fecha usa el parser UTC compartido en el primer paint (content #12)', async () => {
  // Fecha futura fija: 'YYYY-MM-DD HH:mm' se interpreta como UTC en cualquier
  // zona horaria del servidor. Verificamos que los dígitos SSR correspondan.
  const target = new Date(Date.now() + 2 * 86400000)
  const pad = (value) => String(value).padStart(2, '0')
  const targetString = `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())} ${pad(target.getUTCHours())}:${pad(target.getUTCMinutes())}`
  const html = await render([
    { blockType: 'countdown', label: 'Contador', settings: { countdownMode: 'date', countdownTargetDate: targetString } }
  ])
  const days = html.match(/data-rstk-countdown-part="days">(\d{2})</)?.[1]
  assert.ok(days === '01' || days === '02', `días SSR inesperados: ${days}`)
})
