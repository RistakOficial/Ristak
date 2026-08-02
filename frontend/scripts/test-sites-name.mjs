import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  SITE_NAME_MAX_LENGTH,
  normalizeSiteNameInput
} from '../src/pages/Sites/siteNameUtils.ts'

test('normaliza el nombre interno de un sitio sin tocar su contenido', () => {
  assert.equal(normalizeSiteNameInput('  Campaña   Agosto  '), 'Campaña Agosto')
  assert.equal(normalizeSiteNameInput('\nLanding\tprincipal\n'), 'Landing principal')
})

test('limita el nombre interno al máximo aceptado por el editor', () => {
  const longName = 'x'.repeat(SITE_NAME_MAX_LENGTH + 20)
  assert.equal(normalizeSiteNameInput(longName).length, SITE_NAME_MAX_LENGTH)
})

test('expone el cambio de nombre en la biblioteca y antes de la ruta pública', async () => {
  const source = await readFile(new URL('../src/pages/Sites/Sites.tsx', import.meta.url), 'utf8')
  const libraryStart = source.indexOf('const SitesLibraryPanel:')
  const settingsStart = source.indexOf('const SiteSettingsPanelContent:')
  const settingsEnd = source.indexOf('const EditorSettingsDropdown:', settingsStart)
  const librarySource = source.slice(libraryStart, settingsStart)
  const settingsSource = source.slice(settingsStart, settingsEnd)

  assert.match(librarySource, /Cambiar nombre/)
  assert.match(librarySource, /onRename\(site, nextName\)/)
  assert.match(librarySource, /La dirección pública y el título que ven tus visitantes se mantienen igual/)

  const namePosition = settingsSource.indexOf('Nombre del sitio')
  const routePosition = settingsSource.indexOf('Ruta pública')
  assert.ok(namePosition >= 0, 'Ajustes debe mostrar el nombre interno del sitio')
  assert.ok(routePosition > namePosition, 'El nombre interno debe aparecer antes de la ruta pública')
})
