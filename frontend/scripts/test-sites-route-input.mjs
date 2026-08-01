import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRouteSegment,
  normalizeSiteRouteEditorDraft,
  normalizeSiteRouteEditorInput,
  normalizeSiteRoutePath
} from '../src/pages/Sites/siteRouteUtils.ts'

test('normaliza rutas públicas con guiones y subrutas', () => {
  assert.equal(normalizeSiteRoutePath('/Servicios / Diseño-Web/'), 'servicios/diseno-web')
  assert.equal(normalizeSiteRoutePath('ofertas//verano 2026'), 'ofertas/verano-2026')
  assert.equal(normalizeRouteSegment('Página / Especial'), 'pagina-especial')
})

test('el borrador conserva separadores válidos mientras el usuario escribe', () => {
  assert.equal(normalizeSiteRouteEditorDraft('servicios-', 'ejemplo.test'), 'servicios-')
  assert.equal(normalizeSiteRouteEditorDraft('servicios/diseno-web/', 'ejemplo.test'), 'servicios/diseno-web/')
  assert.equal(normalizeSiteRouteEditorDraft('servicios ', 'ejemplo.test'), 'servicios-')
})

test('acepta pegar la URL completa y guarda solamente su ruta canónica', () => {
  assert.equal(
    normalizeSiteRouteEditorInput('https://www.ejemplo.test/Servicios/Diseño-Web/?utm_source=test', 'www.ejemplo.test'),
    'servicios/diseno-web'
  )
  assert.equal(
    normalizeSiteRouteEditorInput('www.ejemplo.test/ofertas/verano', 'www.ejemplo.test'),
    'ofertas/verano'
  )
})
