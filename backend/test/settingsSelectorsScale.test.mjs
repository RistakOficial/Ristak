import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import { listAutomationFormsCatalogPage } from '../src/services/automationsService.js'
import { listSiteSelectors } from '../src/services/sitesService.js'

const domainsSourceUrl = new URL('../../frontend/src/pages/Settings/Domains.tsx', import.meta.url)
const calendarsSourceUrl = new URL('../../frontend/src/pages/Settings/CalendarsConfiguration.tsx', import.meta.url)
const paymentsSourceUrl = new URL('../../frontend/src/pages/Settings/PaymentsConfiguration.tsx', import.meta.url)
const automationCatalogsSourceUrl = new URL('../../frontend/src/services/automationCatalogsService.ts', import.meta.url)
const automationsBackendSourceUrl = new URL('../src/services/automationsService.js', import.meta.url)

async function insertFormSites(marker, count) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const id = `${marker}_${String(index).padStart(3, '0')}`
    ids.push(id)
    const timestamp = `2097-10-${String(Math.floor(index / 24) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00.123456`
    await db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, created_at, updated_at)
       VALUES (?, ?, ?, 'standard_form', 'published', '{}', ?, ?)`,
      [id, `${marker} Formulario ${index}`, `${marker}-${index}`, timestamp, timestamp]
    )
  }
  return ids
}

test('selectores de Sites buscan, paginan e hidratan el valor guardado sin descargar el catálogo', async () => {
  if (databaseDialect === 'sqlite') {
    await db.exec(await readFile(
      new URL('../migrations/versioned/105_settings_selector_indexes.sqlite.sql', import.meta.url),
      'utf8'
    ))
  }
  const marker = `settings_sites_selector_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ids = await insertFormSites(marker, 83)

  try {
    const seen = new Set()
    let cursor = ''
    let pages = 0
    do {
      const page = await listSiteSelectors({ kind: 'forms', search: marker, limit: 17, cursor })
      assert.ok(page.items.length <= 17)
      page.items.forEach(item => seen.add(item.id))
      cursor = page.nextCursor || ''
      pages += 1
      if (!page.hasMore) break
    } while (pages < 10)

    assert.equal(seen.size, 83)
    assert.ok(pages >= 5)

    const selectedId = ids[82]
    const hydrated = await listSiteSelectors({
      kind: 'forms',
      search: `${marker} sin-coincidencias`,
      limit: 20,
      selectedIds: [selectedId]
    })
    assert.equal(hydrated.selectedItems.length, 1)
    assert.equal(hydrated.selectedItems[0].id, selectedId)

    const capped = await listSiteSelectors({ kind: 'forms', search: marker, limit: 500 })
    assert.equal(capped.limit, 50)
    assert.ok(capped.items.length <= 50)
  } finally {
    await db.run(`DELETE FROM public_sites WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
  }
})

test('catálogo de formularios de Automatizaciones recorre más de cien opciones con cursor y recupera IDs seleccionados', async () => {
  const marker = `automation_forms_selector_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const ids = await insertFormSites(marker, 127)

  try {
    const seen = new Set()
    let cursor = ''
    let scopedCursor = ''
    let pages = 0
    do {
      const page = await listAutomationFormsCatalogPage({ search: marker, limit: 19, cursor })
      assert.ok(page.items.length <= 19)
      page.items.forEach(item => seen.add(item.id))
      cursor = page.nextCursor || ''
      if (cursor) scopedCursor = cursor
      pages += 1
      if (!page.hasMore) break
    } while (pages < 12)

    assert.equal(seen.size, 127)
    assert.ok(pages >= 7)

    const selectedId = ids[126]
    const hydrated = await listAutomationFormsCatalogPage({ selectedIds: [selectedId], limit: 20 })
    assert.deepEqual(hydrated.items.map(item => item.id), [selectedId])

    await assert.rejects(
      listAutomationFormsCatalogPage({ search: `${marker}-otro-scope`, cursor: scopedCursor, limit: 19 }),
      /Cursor del catálogo de formularios inválido/
    )
  } finally {
    await db.run(`DELETE FROM public_sites WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
  }
})

test('Configuración difiere catálogos y pasarelas hasta abrir el panel que realmente los necesita', async () => {
  const [domains, calendars, payments, automationCatalogs, automationsBackend] = await Promise.all([
    readFile(domainsSourceUrl, 'utf8'),
    readFile(calendarsSourceUrl, 'utf8'),
    readFile(paymentsSourceUrl, 'utf8'),
    readFile(automationCatalogsSourceUrl, 'utf8'),
    readFile(automationsBackendSourceUrl, 'utf8')
  ])

  assert.doesNotMatch(domains, /listAllSiteSelectors/)
  assert.doesNotMatch(calendars, /listAllSiteSelectors/)
  assert.match(domains, /onSearchChange=\{handleSitesSearch\}/)
  assert.match(calendars, /calendarWizardStep !== 'publicUrl'/)
  assert.match(calendars, /calendarWizardStep !== 'reminders'/)
  assert.match(calendars, /calendarWizardStep !== 'events'/)

  const initialPaymentEffect = payments.slice(
    payments.indexOf('void loadPaymentSettings(controller.signal)'),
    payments.indexOf("if (activeSection !== 'automations'")
  )
  assert.doesNotMatch(initialPaymentEffect, /loadStripeConfig|loadConektaConfig|loadMercadoPagoConfig|loadClipConfig|loadRebillConfig/)
  assert.match(payments, /activeGatewayRoute[\s\S]{0,240}\? \[activeGatewayRoute\]/)
  assert.match(payments, /getTemplates\('APPROVED', \{ signal \}\)/)
  assert.doesNotMatch(payments, /whatsappApiService\.refresh\(\)/)
  assert.doesNotMatch(automationCatalogs, /whatsappApiService\.refresh\(\)/)

  assert.match(automationsBackend, /MAX_AUTOMATION_FORMS_CATALOG_LIMIT = 50/)
  assert.match(automationsBackend, /Promise\.all\(buildAutomationFormsCatalogBranches\(\)/)
  assert.match(automationsBackend, /LIMIT \?/)
  assert.doesNotMatch(automationsBackend, /SELECT id, name, slug, site_type, status, updated_at[\s\S]{0,120}ORDER BY updated_at DESC, name ASC/)
})
