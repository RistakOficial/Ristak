import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  createSubmissionFromRequest,
  deleteSite,
  getSite,
  getSitesTrackingSummary,
  listSites,
  renderPublicSiteHtml,
  updateImportedSiteCodeFiles,
  updateImportedSiteFieldMapping,
  updateSite
} from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

function getSourceQuestionBlocks(site) {
  return (site.blocks || [])
    .filter(block => block.settings?.pageId === 'page-1')
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
}

async function deleteSites(siteIds = []) {
  for (const siteId of new Set(siteIds.filter(Boolean))) {
    await deleteSite(siteId).catch(() => undefined)
  }
}

test('imported HTML forms materialize Forms-page source forms and route submissions to them', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-proxy-${suffix}@example.test`
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  let sourceFormId = ''
  const automationIds = [
    `automation_html_source_${suffix}`,
    `automation_html_imported_${suffix}`
  ]

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    const html = `
      <!doctype html>
      <html>
        <head><title>Landing HTML proxy</title></head>
        <body>
          <main>
            <h1>Agenda una llamada</h1>
            <form id="lead-form">
              <label for="full_name">Nombre completo</label>
              <input id="full_name" name="full_name" placeholder="Tu nombre" required>
              <label for="email">Correo</label>
              <input id="email" type="email" name="email" placeholder="tu@email.com" required>
              <label for="plan">Plan</label>
              <select id="plan" name="plan">
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
              </select>
              <button type="submit">Quiero info</button>
            </form>
          </main>
        </body>
      </html>
    `

    const created = await createImportedSiteFromHtml({
      filename: 'landing-html-proxy.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Landing HTML Proxy ${suffix}`
    })
    siteId = created.site.id

    const mapping = created.import.formMappings[0]
    assert.ok(mapping.formSiteId)
    sourceFormId = mapping.formSiteId

    let sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.siteType, 'standard_form')
    assert.match(sourceForm.name, /^Formulario de Landing HTML Proxy/)
    assert.equal(sourceForm.theme.importedHtmlSource, true)
    assert.equal(sourceForm.theme.importedHtmlSourceSiteId, siteId)
    assert.equal(sourceForm.theme.pages[0].buttonText, 'Quiero info')
    assert.deepEqual(
      getSourceQuestionBlocks(sourceForm).map(block => [block.blockType, block.label, block.placeholder, block.required]),
      [
        ['short_text', 'Nombre completo', 'Tu nombre', true],
        ['email', 'Correo', 'tu@email.com', true],
        ['dropdown', 'Plan', '', false]
      ]
    )

    const savedHtml = created.import.codeFiles[0].content
      .replace('>Quiero info<', '>Enviar lead<')
      .replace('</form>', '<textarea name="message" placeholder="Cuéntanos"></textarea></form>')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: savedHtml }]
    })

    assert.equal(updated.import.formMappings[0].formSiteId, sourceFormId)
    sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.theme.pages[0].buttonText, 'Enviar lead')
    assert.equal(getSourceQuestionBlocks(sourceForm).length, 4)
    assert.ok(getSourceQuestionBlocks(sourceForm).some(block => block.blockType === 'paragraph' && block.label === 'Cuéntanos'))

    await updateSite(siteId, {
      status: 'published',
      siteType: 'landing_page',
      theme: created.site.theme
    })

    const importedTriggerFormId = `${siteId}:imported:${updated.import.formMappings[0].formId}`
    const automationFlow = (formId) => ({
      nodes: [{
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{
            id: 'trigger-form-submitted',
            type: 'trigger-form-submitted',
            config: { form: formId }
          }]
        }
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
    })
    for (const [index, formId] of [sourceFormId, importedTriggerFormId].entries()) {
      const flow = automationFlow(formId)
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationIds[index], `Formulario HTML ${index + 1}`, JSON.stringify(flow), JSON.stringify(flow)]
      )
    }

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${created.site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId,
        importedFormId: updated.import.formMappings[0].formId,
        rawFields: {
          full_name: 'Ana Proxy',
          email,
          plan: 'pro',
          message: 'Necesito detalles'
        }
      }
    )

    const submission = await db.get('SELECT site_id, form_site_id, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.site_id, siteId)
    assert.equal(submission.form_site_id, sourceFormId)
    assert.equal(JSON.parse(submission.meta_json).formSiteId, sourceFormId)

    sourceForm = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: true })
    assert.equal(sourceForm.submissions.length, 1)
    assert.equal(sourceForm.submissions[0].id, result.submissionId)

    const listedSourceForm = (await listSites()).find(site => site.id === sourceFormId)
    assert.equal(listedSourceForm.submissionsCount, 1)

    const summary = await getSitesTrackingSummary({ siteIds: [sourceFormId] })
    assert.equal(summary.bySiteId[sourceFormId].conversions, 1)

    const enrollments = await db.all(
      `SELECT automation_id FROM automation_enrollments
       WHERE contact_id = ? AND automation_id IN (?, ?)`,
      [result.contactId, ...automationIds]
    )
    assert.deepEqual(
      new Set(enrollments.map(enrollment => enrollment.automation_id)),
      new Set(automationIds),
      'el envío HTML debe disparar tanto el formulario visible en Formularios como su identidad importada estable'
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id IN (?, ?)', automationIds).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id IN (?, ?)', automationIds).catch(() => undefined)
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})

test('imported HTML form titles ignore nearby Ristak technical snippets', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  let siteId = ''
  let sourceFormId = ''

  try {
    const html = `
      <!doctype html>
      <html>
        <head><title>Embudo marketing</title></head>
        <body>
          <main>
            <h1>Agenda de clientes</h1>
            <p>lify|open_popup|close_popup" y data-rstk-button-actions='[{"id":"action-1","action":"url","buttonUrl":"https://..."}]'.</p>
            <form id="agenda">
              <label for="appointment_start_time">Fecha y hora</label>
              <input id="appointment_start_time" name="appointment_start_time">
              <label for="goal">Objetivo</label>
              <textarea id="goal" name="goal"></textarea>
              <button type="submit">Agendar</button>
            </form>
          </main>
        </body>
      </html>
    `

    const created = await createImportedSiteFromHtml({
      filename: 'agenda-tecnica.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Agenda tecnica ${suffix}`
    })
    siteId = created.site.id

    const mapping = created.import.formMappings[0]
    sourceFormId = mapping.formSiteId || ''

    assert.equal(mapping.formTitle, 'Agenda de clientes')
    assert.doesNotMatch(mapping.formTitle, /data-rstk-button-actions|open_popup|close_popup/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
  }
})

test('imported HTML rejects explicit unknown or dormant form ids instead of routing to another form', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  let sourceFormId = ''

  const request = {
    headers: { host: 'example.test', 'user-agent': 'node-test' },
    hostname: 'example.test',
    path: '/',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  }

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    const created = await createImportedSiteFromHtml({
      filename: 'form-id-estricto.html',
      name: `Form ID estricto ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-principal">
          <input name="email" type="email" data-rstk-field-id="correo">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormId = created.import.formMappings[0].formSiteId || ''
    request.path = `/${created.site.slug}`

    await updateSite(siteId, {
      status: 'published',
      siteType: 'landing_page',
      theme: created.site.theme
    })

    await assert.rejects(
      () => createSubmissionFromRequest(request, {
        siteId,
        importedFormId: 'otro-formulario',
        rawFields: { email: `wrong-${suffix}@example.test` }
      }),
      error => error?.status === 400
    )

    await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: '<!doctype html><html><body><h1>Sin formulario</h1></body></html>' }]
    })

    await assert.rejects(
      () => createSubmissionFromRequest(request, {
        siteId,
        importedFormId: 'lead-principal',
        rawFields: { email: `dormant-${suffix}@example.test` }
      }),
      error => error?.status === 400
    )
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email IN (?, ?)', [
      `wrong-${suffix}@example.test`,
      `dormant-${suffix}@example.test`
    ]).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})

test('stable field ids separate repeated names and drop removed or arbitrary raw keys', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `stable-fields-${suffix}@example.test`
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  const sourceFormIds = []

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    const created = await createImportedSiteFromHtml({
      filename: 'stable-field-payload.html',
      name: `Stable payload ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-estable">
          <label>Email <input name="contact_value" data-rstk-field-id="email-value"></label>
          <label>Teléfono <input name="contact_value" data-rstk-field-id="phone-value"></label>
          <label>Temporal <input name="removed_value" data-rstk-field-id="removed-value"></label>
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '', formId: 'lead_estable', fieldId: 'email_value',
      destinationType: 'standard', destinationKey: 'email'
    })
    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '', formId: 'lead_estable', fieldId: 'phone_value',
      destinationType: 'standard', destinationKey: 'phone'
    })

    const current = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: `<!doctype html><html><body>
          <form data-rstk-form-id="lead-estable">
            <label>Email <input name="contact_value" data-rstk-field-id="email-value"></label>
            <label>Teléfono <input name="contact_value" data-rstk-field-id="phone-value"></label>
            <button type="submit">Enviar</button>
          </form>
        </body></html>`
      }]
    })
    sourceFormIds.push(...current.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    await updateSite(siteId, {
      status: 'published',
      siteType: 'landing_page',
      theme: created.site.theme
    })
    const rendered = await renderPublicSiteHtml({ ...created.site, status: 'published' }, {
      pageId: 'page-1', trackingEnabled: false, preview: false
    })
    assert.match(rendered, /const getFieldKey = \(field, fallback\) => \(\s*getStableFieldId\(field\) \|\|\s*field\.getAttribute\('name'\)/)
    assert.match(rendered, /getChoiceFields\(field, form, type\)/)

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${created.site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId,
        importedFormId: 'lead-estable',
        rawFields: {
          'email-value': email,
          'phone-value': '+526561234567',
          'removed-value': 'no debe revivir',
          contact_value: 'no debe pisar campos estables',
          arbitrary_admin_key: 'no debe crearse'
        }
      }
    )

    assert.equal(result.contactEmail, email)
    const submission = await db.get(
      'SELECT raw_fields_json, mapped_fields_json FROM public_site_submissions WHERE id = ?',
      [result.submissionId]
    )
    assert.deepEqual(JSON.parse(submission.raw_fields_json), {
      'email-value': email,
      'phone-value': '+526561234567'
    })
    const mapped = JSON.parse(submission.mapped_fields_json)
    assert.deepEqual(mapped.standard, { email, phone: '+526561234567' })
    assert.deepEqual(mapped.custom, {})
    assert.deepEqual(mapped.ignored, {})
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await deleteSites(sourceFormIds)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})

test('public imported submit keeps stable radio scalar and checkbox array values', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const interestsKey = `intereses_grupo_${suffix}`.toLowerCase()
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  const sourceFormIds = []

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    const created = await createImportedSiteFromHtml({
      filename: 'grupos-estables-submit.html',
      name: `Submit grupos estables ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="preferencias-contacto" data-rstk-label="Preferencias">
          <fieldset>
            <legend>Plan</legend>
            <label><input type="radio" name="plan" value="starter" data-rstk-field-id="plan-elegido"> Starter</label>
            <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan-elegido"> Pro</label>
          </fieldset>
          <fieldset>
            <legend>Intereses</legend>
            <label><input type="checkbox" name="intereses" value="ventas" data-rstk-field-id="intereses-seleccionados"> Ventas</label>
            <label><input type="checkbox" name="intereses" value="soporte" data-rstk-field-id="intereses-seleccionados"> Soporte</label>
          </fieldset>
          <button type="submit">Guardar preferencias</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    const detectedForm = created.import.formMappings.find(mapping => mapping.formId === 'preferencias_contacto')
    assert.equal(detectedForm.fields.filter(field => field.present !== false).length, 2)
    assert.deepEqual(
      detectedForm.fields.map(field => [field.fieldId, field.type, field.options.map(option => option.value)]),
      [
        ['plan_elegido', 'radio', ['starter', 'pro']],
        ['intereses_seleccionados', 'checkbox', ['ventas', 'soporte']]
      ]
    )

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'preferencias_contacto',
      fieldId: 'plan_elegido',
      destinationType: 'standard',
      destinationKey: 'message'
    })
    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'preferencias_contacto',
      fieldId: 'intereses_seleccionados',
      destinationType: 'new_custom',
      destinationKey: interestsKey
    })

    await updateSite(siteId, {
      status: 'published',
      siteType: 'landing_page',
      theme: created.site.theme
    })

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${created.site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId,
        importedFormId: 'preferencias-contacto',
        rawFields: {
          'plan-elegido': 'pro',
          'intereses-seleccionados': ['ventas', 'soporte']
        }
      }
    )

    const submission = await db.get(
      'SELECT form_site_id, raw_fields_json, mapped_fields_json FROM public_site_submissions WHERE id = ?',
      [result.submissionId]
    )
    assert.ok(submission.form_site_id)
    assert.deepEqual(JSON.parse(submission.raw_fields_json), {
      'plan-elegido': 'pro',
      'intereses-seleccionados': ['ventas', 'soporte']
    })
    const mapped = JSON.parse(submission.mapped_fields_json)
    assert.deepEqual(mapped.standard, { message: 'pro' })
    assert.deepEqual(mapped.custom, { [interestsKey]: ['ventas', 'soporte'] })
    assert.deepEqual(mapped.ignored, {})
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await deleteSites(sourceFormIds)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})
