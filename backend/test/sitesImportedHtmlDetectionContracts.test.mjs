import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteBySiteId,
  updateImportedSiteCodeFiles,
  updateImportedSiteFieldMapping
} from '../src/services/sitesService.js'

async function deleteSites(siteIds = []) {
  for (const siteId of new Set(siteIds.filter(Boolean))) {
    await deleteSite(siteId).catch(() => undefined)
  }
}

function activeForm(imported, formId) {
  return imported?.formMappings?.find(mapping => (
    mapping.present !== false && mapping.formId === formId
  ))
}

test('import mapping route is atomic PATCH and the former full-array PUT is absent', async () => {
  const routes = await readFile(new URL('../src/routes/sites.routes.js', import.meta.url), 'utf8')
  assert.match(routes, /router\.patch\('\/:siteId\/import-mapping'/)
  assert.doesNotMatch(routes, /router\.put\('\/:siteId\/import-mapping'/)
})

test('only fields inside real form elements are detected and grouped', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'solo-form-real.html',
      name: `Solo form real ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <input name="outside" data-rstk-field-id="outside-field">
        <div data-rstk-form-id="fake-wrapper" data-rstk-label="No es formulario">
          <input name="fake" data-rstk-field-id="fake-field">
        </div>
        <form data-rstk-form-id="real-contact" data-rstk-label="Contacto real">
          <label for="real-email">Correo real</label>
          <input id="real-email" name="email" type="email" data-rstk-field-id="email-contact">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    assert.equal(created.import.detectedForms.length, 1)
    assert.equal(created.import.formMappings.length, 1)
    assert.equal(created.import.formMappings[0].formId, 'real_contact')
    assert.deepEqual(
      created.import.formMappings[0].fields.map(field => field.fieldId),
      ['email_contact']
    )
  } finally {
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('calendar booking fields stay inside the calendar and are not detected as a lead form', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'calendar-and-lead.html',
      name: `Calendar semantic form ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <section data-rstk-native-element="calendar" data-rstk-native-id="agenda" data-rstk-native-render="custom">
          <form data-rstk-calendar-book-form data-rstk-form-id="agenda-reserva">
            <input name="name" data-rstk-calendar-name data-rstk-field-id="agenda-name">
            <input name="email" data-rstk-calendar-email data-rstk-field-id="agenda-email">
            <button type="submit">Agendar</button>
          </form>
        </section>
        <form data-rstk-form-id="lead-real" data-rstk-label="Lead real">
          <input name="email" type="email" data-rstk-field-id="lead-email">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    assert.deepEqual(created.import.detectedForms.map(form => form.id), ['lead_real'])
    assert.deepEqual(created.import.formMappings.map(mapping => mapping.formId), ['lead_real'])
    assert.match(created.import.htmlSanitized, /<form data-rstk-calendar-book-form data-rstk-form-id="agenda-reserva">/)
    assert.doesNotMatch(created.import.htmlSanitized, /<form data-rstk-calendar-book-form[^>]*data-rstk-import-form/)

    const staleCalendarForm = {
      id: 'agenda_reserva',
      importedFormId: 'agenda-reserva',
      hasStableFormId: true,
      sourceFormIndex: 0,
      sourceFormOffset: created.import.htmlSanitized.indexOf('<form data-rstk-calendar-book-form'),
      title: 'Reserva de cita',
      purpose: 'lead_capture',
      submitText: 'Agendar',
      pagePath: '',
      fields: [{ id: 'agenda_email', sourceName: 'email', type: 'email' }]
    }
    const staleCalendarMapping = {
      formId: 'agenda_reserva',
      formTitle: 'Reserva de cita',
      pagePath: '',
      present: true,
      fields: [{
        fieldId: 'agenda_email',
        sourceName: 'email',
        label: 'Correo',
        type: 'email',
        destinationType: 'standard',
        destinationKey: 'email',
        present: true
      }]
    }
    await db.run(`
      UPDATE public_site_imports
      SET detected_forms_json = ?, form_mappings_json = ?
      WHERE site_id = ?
    `, [
      JSON.stringify([staleCalendarForm, ...created.import.detectedForms]),
      JSON.stringify([staleCalendarMapping, ...created.import.formMappings]),
      siteId
    ])

    const reloaded = await getImportedSiteBySiteId(siteId)
    assert.deepEqual(reloaded.detectedForms.map(form => form.id), ['lead_real'])
    assert.equal(activeForm(reloaded, 'agenda_reserva'), undefined)
    assert.equal(reloaded.formMappings.find(mapping => mapping.formId === 'agenda_reserva')?.present, false)
    assert.equal(activeForm(reloaded, 'lead_real')?.present, true)
  } finally {
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('moving a stable form to another imported page preserves mappings and its source form', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []
  const formHtml = `
    <form data-rstk-form-id="lead-movable" data-rstk-label="Lead movible">
      <label for="movable-email">Correo</label>
      <input id="movable-email" name="email" type="email" data-rstk-field-id="contact-email">
      <button type="submit">Enviar</button>
    </form>`

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'sitio-multipagina.html',
      name: `Formulario movible ${suffix}`,
      siteType: 'landing_page',
      pages: [
        {
          id: 'page-a',
          title: 'Pagina A',
          filename: 'a.html',
          html: `<!doctype html><html><body>${formHtml}</body></html>`
        },
        {
          id: 'page-b',
          title: 'Pagina B',
          filename: 'b.html',
          html: '<!doctype html><html><body><h1>Pagina B</h1></body></html>'
        }
      ]
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    const initial = activeForm(created.import, 'lead_movable')
    assert.ok(initial?.formSiteId)
    const sourceFormId = initial.formSiteId

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: 'a.html',
      formId: 'lead_movable',
      fieldId: 'contact_email',
      destinationType: 'standard',
      destinationKey: 'phone'
    })

    await updateImportedSiteCodeFiles(siteId, {
      files: [
        {
          path: 'a.html',
          content: '<!doctype html><html><body><h1>Pagina A</h1></body></html>'
        },
        {
          path: 'b.html',
          content: `<!doctype html><html><body>${formHtml}</body></html>`
        }
      ]
    })

    const persisted = await getImportedSiteBySiteId(siteId)
    const moved = activeForm(persisted, 'lead_movable')
    assert.equal(moved.pagePath, 'b.html')
    assert.equal(moved.formSiteId, sourceFormId)
    assert.equal(moved.fields.find(field => field.fieldId === 'contact_email')?.destinationKey, 'phone')
    assert.equal(
      persisted.formMappings.filter(mapping => mapping.present !== false && mapping.formId === 'lead_movable').length,
      1
    )
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})
