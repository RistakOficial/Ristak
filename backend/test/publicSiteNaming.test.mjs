import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSite,
  deleteSite,
  updateSite
} from '../src/services/sitesService.js'

const makeSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('renombra un sitio y rechaza nombres vacíos', async () => {
  const suffix = makeSuffix()
  let site

  try {
    site = await createSite({
      name: 'Nombre original',
      slug: `site-name-${suffix}`,
      siteType: 'landing_page',
      status: 'draft',
      blankCanvas: true
    })

    const renamed = await updateSite(site.id, { name: '  Campaña Agosto  ' })
    assert.equal(renamed.name, 'Campaña Agosto')

    await assert.rejects(
      updateSite(site.id, { name: '   ' }),
      /El nombre del sitio es obligatorio/
    )

    const preserved = await updateSite(site.id, { description: 'Sin cambiar el nombre' })
    assert.equal(preserved.name, 'Campaña Agosto')
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
  }
})
