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
import { clearHighLevelIntegrationCredentials } from '../src/services/integrationCredentialsCleanupService.js'

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

async function restoreHighLevelConfig(rows = []) {
  await db.run('DELETE FROM highlevel_config')
  for (const row of rows) {
    const columns = Object.keys(row)
    if (!columns.length) continue
    const quotedColumns = columns.map(column => `"${String(column).replace(/"/g, '""')}"`).join(', ')
    await db.run(
      `INSERT INTO highlevel_config (${quotedColumns}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => row[column])
    )
  }
}

test('imported HTML forms materialize Forms-page source forms and route submissions to them', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-proxy-${suffix}@example.test`
  const legacyEmail = `html-proxy-legacy-${suffix}@example.test`
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

    const messageMapping = updated.import.formMappings[0].fields.find(field => field.sourceName === 'message')
    assert.equal(messageMapping?.destinationType, 'custom')
    assert.equal(messageMapping?.destinationKey, 'form_message')
    assert.ok(messageMapping?.customFieldDefinitionId)

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
            config: {
              form: formId,
              filters: [{ field: 'form-specific', match: 'is', value: formId }]
            }
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

    const contact = await db.get('SELECT full_name, email, custom_fields FROM contacts WHERE id = ?', [result.contactId])
    assert.equal(contact.full_name, 'Ana Proxy')
    assert.equal(contact.email, email)
    const contactMessage = JSON.parse(contact.custom_fields || '[]').find(field => field.fieldKey === 'form_message')
    assert.equal(contactMessage?.value, 'Necesito detalles')
    assert.equal(contactMessage?.definitionId, messageMapping.customFieldDefinitionId)

    const submission = await db.get('SELECT site_id, form_site_id, mapped_fields_json, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.site_id, siteId)
    assert.equal(submission.form_site_id, sourceFormId)
    assert.equal(JSON.parse(submission.mapped_fields_json).custom.form_message, 'Necesito detalles')
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

    const legacyMappings = updated.import.formMappings.map(mapping => ({
      ...mapping,
      fields: mapping.fields.map(field => field.sourceName === 'message'
        ? {
            ...field,
            destinationType: 'standard',
            destinationKey: 'message',
            saveMode: 'standard',
            customFieldDefinitionId: undefined,
            customFieldKey: undefined,
            customFieldLabel: undefined,
            customFieldDataType: undefined,
            customFieldSyncTarget: undefined
          }
        : field)
    }))
    await db.run(
      'UPDATE public_site_imports SET form_mappings_json = ? WHERE site_id = ?',
      [JSON.stringify(legacyMappings), siteId]
    )

    const legacyResult = await createSubmissionFromRequest(
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
          full_name: 'Laura Legacy',
          email: legacyEmail,
          plan: 'starter',
          message: 'Respuesta recuperada desde un mapeo anterior'
        }
      }
    )
    assert.equal(legacyResult.mappedFields.standard.message, undefined)
    assert.equal(legacyResult.mappedFields.custom.form_message, 'Respuesta recuperada desde un mapeo anterior')
    const legacyContact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [legacyResult.contactId])
    assert.equal(
      JSON.parse(legacyContact.custom_fields || '[]').find(field => field.fieldKey === 'form_message')?.value,
      'Respuesta recuperada desde un mapeo anterior'
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id IN (?, ?)', automationIds).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id IN (?, ?)', automationIds).catch(() => undefined)
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email IN (?, ?)', [email, legacyEmail]).catch(() => undefined)
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

test('imported HTML forms read native tracking identity at submit time', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'tracking-identity.html',
      name: `Tracking identity ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-principal">
          <input name="email" type="email" data-rstk-field-id="correo">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    const rendered = await renderPublicSiteHtml({ ...created.site, status: 'published' }, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })
    const submitListenerIndex = rendered.indexOf("form.addEventListener('submit'")
    const liveIdentityIndex = rendered.indexOf('const nativeIdentity = getNativeIdentity();', submitListenerIndex)

    assert.ok(submitListenerIndex >= 0)
    assert.ok(liveIdentityIndex > submitListenerIndex, 'la identidad debe leerse dentro de cada submit')
    assert.match(rendered, /window\.ristakNativeIdentity = \(\) =>/)
    assert.match(rendered, /window\.ristakNativeBuildData = buildTrackingData/)
    assert.match(rendered, /visitorId: nativeIdentity\.visitorId \|\| null/)
    assert.match(rendered, /sessionId: nativeIdentity\.sessionId \|\| null/)
    assert.match(rendered, /tracking: nativeTracking/)
    assert.doesNotMatch(rendered, /const TRACKING = window\.ristakNativeTracking/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await deleteSites(sourceFormIds)
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
    assert.match(rendered, /const getFieldKey = \(field, form, fallback\) => \{/)
    assert.match(rendered, /const getChoiceFieldKey = \(field, form, type\) => \{/)
    assert.match(rendered, /new Set\(stableIds\)\.size === 1/)
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

test('public imported submit stores text and typed choices locally without HighLevel and preserves them after disconnect', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `typed-html-${suffix}@example.test`
  const situationKey = `situacion_consultorio_${suffix}`.toLowerCase()
  const planKey = `plan_grupo_${suffix}`.toLowerCase()
  const consentKey = `consentimiento_grupo_${suffix}`.toLowerCase()
  const interestsKey = `intereses_grupo_${suffix}`.toLowerCase()
  const priorityKey = `prioridad_grupo_${suffix}`.toLowerCase()
  const channelsKey = `canales_grupo_${suffix}`.toLowerCase()
  const customFieldKeys = [situationKey, planKey, consentKey, interestsKey, priorityKey, channelsKey]
  const previousHighLevelConfig = await db.all('SELECT * FROM highlevel_config')
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let siteId = ''
  const sourceFormIds = []

  try {
    await db.run('DELETE FROM highlevel_config')
    const disconnectedConfig = await db.get('SELECT COUNT(*) AS total FROM highlevel_config')
    assert.equal(Number(disconnectedConfig.total), 0)

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
          <label for="email">Correo</label>
          <input id="email" type="email" name="email" data-rstk-field-id="email">
          <label for="situacion">¿Cuál es la situación actual de tu consultorio?</label>
          <textarea id="situacion" name="situacion" data-rstk-field-id="situacion"></textarea>
          <fieldset>
            <legend>Plan</legend>
            <label><input type="radio" name="plan" value="starter" data-rstk-field-id="plan-starter"> Starter</label>
            <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan-pro"> Pro</label>
          </fieldset>
          <label>
            <input type="checkbox" name="consentimiento" value="aceptado" data-rstk-field-id="consentimiento">
            Acepto contacto
          </label>
          <fieldset>
            <legend>Intereses</legend>
            <label><input type="checkbox" name="intereses" value="ventas" data-rstk-field-id="interes-ventas"> Ventas</label>
            <label><input type="checkbox" name="intereses" value="soporte" data-rstk-field-id="interes-soporte"> Soporte</label>
          </fieldset>
          <label for="prioridad">Prioridad</label>
          <select id="prioridad" name="prioridad" data-rstk-field-id="prioridad">
            <option value="normal">Normal</option>
            <option value="urgente">Urgente</option>
          </select>
          <label for="canales">Canales</label>
          <select id="canales" name="canales" data-rstk-field-id="canales" multiple>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <button type="submit">Guardar preferencias</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    const detectedForm = created.import.formMappings.find(mapping => mapping.formId === 'preferencias_contacto')
    assert.equal(detectedForm.fields.filter(field => field.present !== false).length, 7)
    assert.deepEqual(
      detectedForm.fields.map(field => [field.fieldId, field.type, field.options.map(option => option.value)]),
      [
        ['email', 'email', []],
        ['situacion', 'textarea', []],
        ['plan', 'radio', ['starter', 'pro']],
        ['consentimiento', 'checkbox', ['aceptado']],
        ['intereses', 'checkbox', ['ventas', 'soporte']],
        ['prioridad', 'select', ['normal', 'urgente']],
        ['canales', 'multiselect', ['email', 'whatsapp']]
      ]
    )
    assert.equal(detectedForm.fields.find(field => field.fieldId === 'plan').hasStableFieldId, false)
    assert.equal(detectedForm.fields.find(field => field.fieldId === 'intereses').hasStableFieldId, false)

    for (const [fieldId, destinationKey] of [
      ['situacion', situationKey],
      ['plan', planKey],
      ['consentimiento', consentKey],
      ['intereses', interestsKey],
      ['prioridad', priorityKey],
      ['canales', channelsKey]
    ]) {
      await updateImportedSiteFieldMapping(siteId, {
        pagePath: '',
        formId: 'preferencias_contacto',
        fieldId,
        destinationType: 'new_custom',
        destinationKey
      })
    }

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
          email,
          situacion: 'Necesito atraer pacientes de forma constante.',
          plan: 'pro',
          consentimiento: 'aceptado',
          intereses: ['ventas', 'soporte'],
          prioridad: 'urgente',
          canales: ['email', 'whatsapp']
        }
      }
    )

    const submission = await db.get(
      'SELECT form_site_id, raw_fields_json, mapped_fields_json FROM public_site_submissions WHERE id = ?',
      [result.submissionId]
    )
    assert.ok(submission.form_site_id)
    assert.deepEqual(JSON.parse(submission.raw_fields_json), {
      email,
      situacion: 'Necesito atraer pacientes de forma constante.',
      plan: 'pro',
      consentimiento: ['aceptado'],
      intereses: ['ventas', 'soporte'],
      prioridad: 'urgente',
      canales: ['email', 'whatsapp']
    })
    const mapped = JSON.parse(submission.mapped_fields_json)
    assert.deepEqual(mapped.standard, { email })
    assert.deepEqual(mapped.custom, {
      [situationKey]: 'Necesito atraer pacientes de forma constante.',
      [planKey]: 'pro',
      [consentKey]: ['aceptado'],
      [interestsKey]: ['ventas', 'soporte'],
      [priorityKey]: 'urgente',
      [channelsKey]: ['email', 'whatsapp']
    })
    assert.deepEqual(mapped.ignored, {})

    const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [result.contactId])
    const customFields = JSON.parse(contact.custom_fields || '[]')
    assert.deepEqual(
      Object.fromEntries(customFields.map(field => [field.fieldKey, {
        dataType: field.dataType,
        value: field.value,
        options: field.options.map(option => option.value)
      }])),
      {
        [situationKey]: {
          dataType: 'textarea',
          value: 'Necesito atraer pacientes de forma constante.',
          options: []
        },
        [planKey]: {
          dataType: 'radio',
          value: 'pro',
          options: ['starter', 'pro']
        },
        [consentKey]: {
          dataType: 'checkboxes',
          value: ['aceptado'],
          options: ['aceptado']
        },
        [interestsKey]: {
          dataType: 'checkboxes',
          value: ['ventas', 'soporte'],
          options: ['ventas', 'soporte']
        },
        [priorityKey]: {
          dataType: 'dropdown',
          value: 'urgente',
          options: ['normal', 'urgente']
        },
        [channelsKey]: {
          dataType: 'multiselect',
          value: ['email', 'whatsapp'],
          options: ['email', 'whatsapp']
        }
      }
    )

    const definitions = await db.all(`
      SELECT field_key, data_type, options_json
      FROM contact_custom_field_definitions
      WHERE field_key IN (?, ?, ?, ?, ?, ?)
      ORDER BY field_key ASC
    `, customFieldKeys)
    assert.deepEqual(
      Object.fromEntries(definitions.map(definition => [definition.field_key, {
        dataType: definition.data_type,
        options: JSON.parse(definition.options_json || '[]').map(option => option.value)
      }])),
      {
        [situationKey]: { dataType: 'textarea', options: [] },
        [planKey]: { dataType: 'radio', options: ['starter', 'pro'] },
        [consentKey]: { dataType: 'checkboxes', options: ['aceptado'] },
        [interestsKey]: { dataType: 'checkboxes', options: ['ventas', 'soporte'] },
        [priorityKey]: { dataType: 'dropdown', options: ['normal', 'urgente'] },
        [channelsKey]: { dataType: 'multiselect', options: ['email', 'whatsapp'] }
      }
    )

    await clearHighLevelIntegrationCredentials()
    const contactAfterDisconnect = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [result.contactId])
    assert.deepEqual(
      JSON.parse(contactAfterDisconnect.custom_fields || '[]'),
      customFields,
      'desconectar HighLevel no debe borrar las respuestas locales del formulario'
    )

    await assert.rejects(
      () => createSubmissionFromRequest(
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
            email: `invalid-${email}`,
            plan: 'enterprise',
            consentimiento: 'aceptado',
            intereses: ['ventas'],
            prioridad: 'urgente',
            canales: ['email']
          }
        }
      ),
      error => error?.status === 400 && /opción inválida/.test(error.message)
    )

    await assert.rejects(
      () => createSubmissionFromRequest(
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
            email: `multiple-${email}`,
            plan: ['starter', 'pro'],
            consentimiento: 'aceptado',
            intereses: ['ventas'],
            prioridad: 'normal',
            canales: ['whatsapp']
          }
        }
      ),
      error => error?.status === 400 && /solo acepta una opción/.test(error.message)
    )
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await deleteSites(sourceFormIds)
    const definitions = await db.all(
      'SELECT id FROM contact_custom_field_definitions WHERE field_key IN (?, ?, ?, ?, ?, ?)',
      customFieldKeys
    ).catch(() => [])
    for (const definition of definitions) {
      await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [definition.id]).catch(() => undefined)
      await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [definition.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await restoreHighLevelConfig(previousHighLevelConfig).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
})
