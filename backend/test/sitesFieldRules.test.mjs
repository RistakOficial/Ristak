import test from 'node:test'
import assert from 'node:assert/strict'

import { getNativeFieldRulesAttributes } from '../../shared/sites/renderContract.js'

const attrs = (blockType, settings = {}) => getNativeFieldRulesAttributes({ blockType, settings })

test('retrocompat: currency sin settings mantiene el render histórico (inputmode/min=0/step=0.01)', () => {
  assert.deepEqual(attrs('currency'), { inputmode: 'decimal', min: 0, step: 0.01 })
})

test('retrocompat: number sin settings solo inputmode=decimal (como antes)', () => {
  assert.deepEqual(attrs('number'), { inputmode: 'decimal' })
})

test('retrocompat: date sin settings no emite atributos (como antes)', () => {
  assert.deepEqual(attrs('date'), {})
})

test('number: min/max/step configurables', () => {
  assert.deepEqual(attrs('number', { numberMin: 10, numberMax: 100, numberStep: 5 }), {
    inputmode: 'decimal', min: 10, max: 100, step: 5
  })
})

test('number: step<=0 se ignora; min negativo permitido', () => {
  assert.deepEqual(attrs('number', { numberMin: -50, numberStep: 0 }), { inputmode: 'decimal', min: -50 })
})

test('currency: decimales controlan el step (2->0.01, 3->0.001, 0->1)', () => {
  assert.equal(attrs('currency', { currencyDecimals: 2 }).step, 0.01)
  assert.equal(attrs('currency', { currencyDecimals: 3 }).step, 0.001)
  assert.equal(attrs('currency', { currencyDecimals: 0 }).step, 1)
})

test('currency: min propio y max opcional', () => {
  assert.deepEqual(attrs('currency', { currencyMin: 100, currencyMax: 5000, currencyDecimals: 0 }), {
    inputmode: 'decimal', min: 100, max: 5000, step: 1
  })
})

test('currency: decimales fuera de rango se recortan a [0,4]', () => {
  assert.equal(attrs('currency', { currencyDecimals: 9 }).step, 0.0001) // clamp a 4
  assert.equal(attrs('currency', { currencyDecimals: -2 }).step, 1) // clamp a 0
})

test('date: solo acepta YYYY-MM-DD, ignora formatos inválidos', () => {
  assert.deepEqual(attrs('date', { dateMin: '2026-01-01', dateMax: '2026-12-31' }), {
    min: '2026-01-01', max: '2026-12-31'
  })
  assert.deepEqual(attrs('date', { dateMin: '01/01/2026', dateMax: 'ayer' }), {})
})

test('robustez: null/undefined/"" NO se interpretan como 0', () => {
  assert.deepEqual(attrs('number', { numberMin: null, numberMax: '', numberStep: undefined }), { inputmode: 'decimal' })
  // currency con min null cae al default 0 (no rompe)
  assert.deepEqual(attrs('currency', { currencyMin: null }), { inputmode: 'decimal', min: 0, step: 0.01 })
})

test('tipos no-regla no emiten nada', () => {
  assert.deepEqual(attrs('short_text'), {})
  assert.deepEqual(attrs('email'), {})
})

test('render público: un campo number con rango emite min/max/step; currency sin settings mantiene min=0 step=0.01', async () => {
  const { renderPublicSiteHtml } = await import('../src/services/sitesService.js')
  const site = {
    id: 'site_fr', name: 'F', title: 'F', description: '', slug: 'f',
    siteType: 'standard_form', status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [
      { id: 'num-1', siteId: 'site_fr', blockType: 'number', label: 'Edad', content: '', options: [], sortOrder: 0, settings: { pageId: 'page-1', numberMin: 18, numberMax: 99, numberStep: 1 }, createdAt: '', updatedAt: '' },
      { id: 'cur-1', siteId: 'site_fr', blockType: 'currency', label: 'Monto', content: '', options: [], sortOrder: 1, settings: { pageId: 'page-1' }, createdAt: '', updatedAt: '' },
      { id: 'dat-1', siteId: 'site_fr', blockType: 'date', label: 'Fecha', content: '', options: [], sortOrder: 2, settings: { pageId: 'page-1', dateMin: '2026-01-01' }, createdAt: '', updatedAt: '' }
    ]
  }
  const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /id="num-1"[^>]*min="18"[^>]*max="99"[^>]*step="1"/)
  // currency sin settings = comportamiento histórico exacto
  assert.match(html, /id="cur-1"[^>]*inputmode="decimal"[^>]*min="0"[^>]*step="0.01"/)
  assert.match(html, /id="dat-1"[^>]*type="date"[^>]*min="2026-01-01"/)
})
