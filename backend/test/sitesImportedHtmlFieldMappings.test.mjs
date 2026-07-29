import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteBySiteId,
  getSite,
  renderPublicSiteHtml,
  updateImportedSiteCodeFiles,
  updateImportedSiteFieldMapping
} from '../src/services/sitesService.js'

function activeMapping(imported, pagePath, formId) {
  return imported.formMappings.find(mapping => (
    mapping.present !== false &&
    mapping.pagePath === pagePath &&
    mapping.formId === formId
  ))
}

function mappingField(mapping, fieldId) {
  return mapping?.fields?.find(field => field.fieldId === fieldId)
}

function assertIncludes(actual, expected) {
  assert.ok(actual, 'expected an object to compare')
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `unexpected value for ${key}`)
  }
}

async function deleteSites(siteIds = []) {
  for (const siteId of new Set(siteIds.filter(Boolean))) {
    await deleteSite(siteId).catch(() => undefined)
  }
}

test('stable form + field identities isolate repeated fields while pagePath guards atomic PATCH routes', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const generatedSourceSiteIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'campos-estables.html',
      name: `Campos HTML estables ${suffix}`,
      siteType: 'landing_page',
      pages: [
        {
          id: 'inicio',
          title: 'Inicio',
          filename: 'inicio.html',
          html: `<!doctype html><html><body>
            <form data-rstk-form-id="inicio-lead" data-rstk-label="Lead principal">
              <label for="inicio-email">Correo principal</label>
              <input id="inicio-email" name="email" type="email" data-rstk-field-id="email">
              <button type="submit">Enviar</button>
            </form>
            <form data-rstk-form-id="inicio-socio" data-rstk-label="Lead de socio">
              <label for="socio-email">Correo de socio</label>
              <input id="socio-email" name="email" type="email" data-rstk-field-id="email">
              <button type="submit">Enviar</button>
            </form>
          </body></html>`
        },
        {
          id: 'oferta',
          title: 'Oferta',
          filename: 'oferta.html',
          html: `<!doctype html><html><body>
            <form data-rstk-form-id="oferta-lead" data-rstk-label="Lead de oferta">
              <label for="oferta-email">Correo de oferta</label>
              <input id="oferta-email" name="email" type="email" data-rstk-field-id="email">
              <button type="submit">Enviar</button>
            </form>
          </body></html>`
        }
      ]
    })
    siteId = created.site.id
    generatedSourceSiteIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    assert.deepEqual(
      created.import.formMappings
        .filter(mapping => mapping.present !== false)
        .map(mapping => [mapping.pagePath, mapping.formId, mapping.fields[0].fieldId]),
      [
        ['inicio.html', 'inicio_lead', 'email'],
        ['inicio.html', 'inicio_socio', 'email'],
        ['oferta.html', 'oferta_lead', 'email']
      ]
    )

    await Promise.all([
      updateImportedSiteFieldMapping(siteId, {
        pagePath: 'inicio.html',
        formId: 'inicio_lead',
        fieldId: 'email',
        destinationType: 'standard',
        destinationKey: 'full_name'
      }),
      updateImportedSiteFieldMapping(siteId, {
        pagePath: 'inicio.html',
        formId: 'inicio_socio',
        fieldId: 'email',
        destinationType: 'standard',
        destinationKey: 'phone'
      }),
      updateImportedSiteFieldMapping(siteId, {
        pagePath: 'oferta.html',
        formId: 'oferta_lead',
        fieldId: 'email',
        destinationType: 'ignored'
      })
    ])

    const imported = await getImportedSiteBySiteId(siteId)
    generatedSourceSiteIds.push(...imported.formMappings.map(mapping => mapping.formSiteId))

    assertIncludes(mappingField(activeMapping(imported, 'inicio.html', 'inicio_lead'), 'email'), {
      destinationType: 'standard',
      destinationKey: 'full_name',
      ignored: false,
      present: true
    })
    assertIncludes(mappingField(activeMapping(imported, 'inicio.html', 'inicio_socio'), 'email'), {
      destinationType: 'standard',
      destinationKey: 'phone',
      ignored: false,
      present: true
    })
    assertIncludes(mappingField(activeMapping(imported, 'oferta.html', 'oferta_lead'), 'email'), {
      destinationType: 'ignored',
      ignored: true,
      present: true
    })

    await assert.rejects(
      () => updateImportedSiteFieldMapping(siteId, {
        pagePath: 'otra-pagina.html',
        formId: 'inicio_lead',
        fieldId: 'email',
        destinationType: 'standard',
        destinationKey: 'email'
      }),
      error => error?.status === 409
    )
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      generatedSourceSiteIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...generatedSourceSiteIds])
  }
})

test('stable form and field ids retain custom metadata through rewrites, disappearance and reappearance', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const definitionId = `contact_field_html_mapping_${suffix}`
  const definitionKey = `empresa_html_${suffix}`.toLowerCase()
  let siteId = ''
  let sourceFormId = ''

  const htmlWithCompany = ({ companyName = 'company', companyId = 'company', companyLabel = 'Empresa' } = {}) => `
    <!doctype html><html><body>
      <form class="lead-form" data-rstk-form-id="inicio-contacto" data-rstk-label="Contacto comercial">
        <label for="${companyId}">${companyLabel}</label>
        <input id="${companyId}" name="${companyName}" data-rstk-field-id="empresa-fiscal">
        <label for="email">Correo</label>
        <input id="email" name="email" type="email" data-rstk-field-id="correo-contacto">
        <button type="submit">Solicitar información</button>
      </form>
    </body></html>`

  try {
    await db.run(`
      INSERT INTO contact_custom_field_definitions (
        id, field_key, label, data_type, sync_target, source_type, archived,
        created_at, updated_at
      ) VALUES (?, ?, 'Razón social', 'text', 'highlevel', 'manual', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [definitionId, definitionKey])

    const created = await createImportedSiteFromHtml({
      filename: 'persistencia-mapeo.html',
      name: `Persistencia mapeo HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(htmlWithCompany(), 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormId = created.import.formMappings[0].formSiteId

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'inicio_contacto',
      fieldId: 'empresa_fiscal',
      destinationType: 'custom',
      customFieldDefinitionId: definitionId
    })

    let imported = await getImportedSiteBySiteId(siteId)
    let form = activeMapping(imported, '', 'inicio_contacto')
    let company = mappingField(form, 'empresa_fiscal')
    assertIncludes(company, {
      destinationType: 'custom',
      destinationKey: definitionKey,
      saveMode: 'custom',
      customFieldDefinitionId: definitionId,
      customFieldKey: definitionKey,
      customFieldLabel: 'Razón social',
      customFieldDataType: 'text',
      customFieldSyncTarget: 'highlevel',
      present: true
    })

    const rewritten = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: htmlWithCompany({
          companyName: 'legal_entity_name',
          companyId: 'company-v2',
          companyLabel: 'Nombre legal de la empresa'
        }).replace('class="lead-form"', 'class="lead-form refreshed"')
      }]
    })
    form = activeMapping(rewritten.import, '', 'inicio_contacto')
    company = mappingField(form, 'empresa_fiscal')
    assert.equal(form.formSiteId, sourceFormId)
    assert.equal(company.sourceName, 'legal_entity_name')
    assert.equal(company.label, 'Nombre legal de la empresa')
    assertIncludes(company, {
      destinationType: 'custom',
      destinationKey: definitionKey,
      customFieldDefinitionId: definitionId,
      customFieldKey: definitionKey,
      customFieldLabel: 'Razón social',
      customFieldDataType: 'text',
      customFieldSyncTarget: 'highlevel',
      present: true
    })

    const withoutCompany = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: `<!doctype html><html><body>
          <form data-rstk-form-id="inicio-contacto" data-rstk-label="Contacto comercial">
            <label for="email">Correo</label>
            <input id="email" name="email" type="email" data-rstk-field-id="correo-contacto">
            <button type="submit">Solicitar información</button>
          </form>
        </body></html>`
      }]
    })
    form = activeMapping(withoutCompany.import, '', 'inicio_contacto')
    company = mappingField(form, 'empresa_fiscal')
    assert.equal(form.present, true)
    assertIncludes(company, {
      customFieldDefinitionId: definitionId,
      destinationKey: definitionKey,
      present: false
    })

    const withoutForm = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: '<!doctype html><html><body><main><h1>Próximamente</h1></main></body></html>' }]
    })
    form = withoutForm.import.formMappings.find(mapping => mapping.formId === 'inicio_contacto')
    assert.equal(form.present, false)
    assert.equal(mappingField(form, 'empresa_fiscal').present, false)

    const restored = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: htmlWithCompany({
          companyName: 'registered_company',
          companyId: 'registered-company',
          companyLabel: 'Empresa registrada'
        })
      }]
    })
    form = activeMapping(restored.import, '', 'inicio_contacto')
    company = mappingField(form, 'empresa_fiscal')
    assert.equal(form.formSiteId, sourceFormId)
    assertIncludes(company, {
      sourceName: 'registered_company',
      label: 'Empresa registrada',
      destinationType: 'custom',
      destinationKey: definitionKey,
      customFieldDefinitionId: definitionId,
      customFieldKey: definitionKey,
      customFieldLabel: 'Razón social',
      customFieldDataType: 'text',
      customFieldSyncTarget: 'highlevel',
      present: true
    })
  } finally {
    await deleteSites([siteId, sourceFormId])
    await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [definitionId]).catch(() => undefined)
    await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [definitionId]).catch(() => undefined)
  }
})

test('wrapped labels and choice-group labels stay semantic while option labels remain intact', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'etiquetas-semanticas.html',
      name: `Etiquetas HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="perfil-etiquetas" data-rstk-label="Perfil con etiquetas">
          <label>Nombre del cliente <input name="nombre_cliente" data-rstk-field-id="nombre-cliente"></label>
          <fieldset>
            <legend>Plan</legend>
            <label><input type="radio" name="plan" value="basic" data-rstk-field-id="plan"> Básico</label>
            <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan"> Pro</label>
          </fieldset>
          <fieldset aria-label="Intereses accesibles">
            <legend>Intereses visibles</legend>
            <label><input type="checkbox" name="intereses" value="email" data-rstk-field-id="intereses"> Email</label>
            <label><input type="checkbox" name="intereses" value="whatsapp" data-rstk-field-id="intereses"> WhatsApp</label>
          </fieldset>
          <fieldset data-rstk-label="Canal configurado" aria-label="Canal accesible">
            <legend>Canal visible</legend>
            <label><input type="radio" name="canal" value="telefono" data-rstk-field-id="canal"> Teléfono</label>
            <label><input type="radio" name="canal" value="correo" data-rstk-field-id="canal"> Correo</label>
          </fieldset>
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    const form = activeMapping(created.import, '', 'perfil_etiquetas')
    assert.equal(mappingField(form, 'nombre_cliente').label, 'Nombre del cliente')
    assert.equal(mappingField(form, 'plan').label, 'Plan')
    assert.deepEqual(mappingField(form, 'plan').options, [
      { label: 'Básico', value: 'basic' },
      { label: 'Pro', value: 'pro' }
    ])
    assert.equal(mappingField(form, 'intereses').label, 'Intereses accesibles')
    assert.deepEqual(mappingField(form, 'intereses').options.map(option => option.label), ['Email', 'WhatsApp'])
    assert.equal(mappingField(form, 'canal').label, 'Canal configurado')
    assert.deepEqual(mappingField(form, 'canal').options.map(option => option.label), ['Teléfono', 'Correo'])
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('new imported choice mappings keep their canonical answer type in the source form', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []
  const fieldKeys = {
    plan: `plan_html_${suffix}`.toLowerCase(),
    consent: `consentimiento_html_${suffix}`.toLowerCase(),
    interests: `intereses_html_${suffix}`.toLowerCase(),
    channels: `canales_html_${suffix}`.toLowerCase()
  }

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'tipos-opciones.html',
      name: `Tipos de opciones HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="preferencias-tipadas" data-rstk-label="Preferencias tipadas">
          <fieldset>
            <legend>Plan</legend>
            <label><input type="radio" name="plan" value="starter" data-rstk-field-id="plan"> Starter</label>
            <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan"> Pro</label>
          </fieldset>
          <label>
            <input type="checkbox" name="consentimiento" value="aceptado" data-rstk-field-id="consentimiento">
            Acepto contacto
          </label>
          <fieldset>
            <legend>Intereses</legend>
            <label><input type="checkbox" name="intereses" value="ventas" data-rstk-field-id="intereses"> Ventas</label>
            <label><input type="checkbox" name="intereses" value="soporte" data-rstk-field-id="intereses"> Soporte</label>
          </fieldset>
          <label for="canales">Canales</label>
          <select id="canales" name="canales" data-rstk-field-id="canales" multiple>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <button type="submit">Guardar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    let form = activeMapping(created.import, '', 'preferencias_tipadas')
    assert.deepEqual(
      form.fields.map(field => [field.fieldId, field.type]),
      [
        ['plan', 'radio'],
        ['consentimiento', 'checkbox'],
        ['intereses', 'checkbox'],
        ['canales', 'multiselect']
      ]
    )

    const staleTypesByFieldId = {
      plan: 'select',
      consentimiento: 'checkbox',
      intereses: 'multiselect',
      canales: 'select'
    }
    const legacyMappings = created.import.formMappings.map(mapping => (
      mapping.formId !== 'preferencias_tipadas'
        ? mapping
        : {
            ...mapping,
            fields: mapping.fields.map(field => ({
              ...field,
              customFieldDataType: staleTypesByFieldId[field.fieldId] || field.customFieldDataType
            }))
          }
    ))
    await db.run(`
      UPDATE public_site_imports SET
        form_mappings_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE site_id = ?
    `, [JSON.stringify(legacyMappings), siteId])

    for (const [sourceFieldId, destinationKey] of [
      ['plan', fieldKeys.plan],
      ['consentimiento', fieldKeys.consent],
      ['intereses', fieldKeys.interests],
      ['canales', fieldKeys.channels]
    ]) {
      await updateImportedSiteFieldMapping(siteId, {
        pagePath: '',
        formId: 'preferencias_tipadas',
        fieldId: sourceFieldId,
        destinationType: 'new_custom',
        destinationKey
      })
    }

    const imported = await getImportedSiteBySiteId(siteId)
    form = activeMapping(imported, '', 'preferencias_tipadas')
    assert.deepEqual(
      form.fields.map(field => [field.fieldId, field.customFieldDataType]),
      [
        ['plan', 'radio'],
        ['consentimiento', 'checkboxes'],
        ['intereses', 'checkboxes'],
        ['canales', 'checkboxes']
      ]
    )

    const sourceForm = await getSite(form.formSiteId, { includeBlocks: true, includeSubmissions: false })
    const importedBlocks = sourceForm.blocks
      .filter(block => block.settings?.importedHtmlSource === true)
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
    assert.deepEqual(
      importedBlocks.map(block => [
        block.blockType,
        block.settings.customFieldDataType,
        block.options?.map(option => option.value) || []
      ]),
      [
        ['radio', 'radio', ['starter', 'pro']],
        ['checkboxes', 'checkboxes', ['aceptado']],
        ['checkboxes', 'checkboxes', ['ventas', 'soporte']],
        ['checkboxes', 'checkboxes', ['email', 'whatsapp']]
      ]
    )
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('per-option ids collapse into four logical questions and legacy mappings normalize without losing their association', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'preguntas-con-ids-por-opcion.html',
      name: `Preguntas HTML agrupadas ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="perfil-medico" data-rstk-label="Perfil médico">
          <fieldset>
            <legend>¿Cuál es tu rol?</legend>
            <label><input type="radio" name="rol_decision" value="propietario" data-rstk-field-id="rol-propietario-socio"> Propietario</label>
            <label><input type="radio" name="rol_decision" value="director" data-rstk-field-id="rol-director-decisor"> Director</label>
            <label><input type="radio" name="rol_decision" value="sin_decision" data-rstk-field-id="rol-sin-decision"> No decido</label>
          </fieldset>
          <fieldset>
            <legend>¿En qué estado está tu consultorio?</legend>
            <label><input type="radio" name="estado_consultorio" value="operando" data-rstk-field-id="estado-operando"> Operando</label>
            <label><input type="radio" name="estado_consultorio" value="abriendo" data-rstk-field-id="estado-abriendo"> Abriendo</label>
            <label><input type="radio" name="estado_consultorio" value="idea" data-rstk-field-id="estado-idea"> Es una idea</label>
          </fieldset>
          <label for="especialidad">Especialidad</label>
          <select id="especialidad" name="especialidad" data-rstk-field-id="especialidad">
            <option value="medicina_general">Medicina general</option>
            <option value="pediatria">Pediatría</option>
          </select>
          <fieldset>
            <legend>¿Cuándo quieres implementarlo?</legend>
            <label><input type="radio" name="plazo_implementacion" value="ahora" data-rstk-field-id="plazo-ahora"> Ahora</label>
            <label><input type="radio" name="plazo_implementacion" value="mes" data-rstk-field-id="plazo-un-mes"> En un mes</label>
            <label><input type="radio" name="plazo_implementacion" value="despues" data-rstk-field-id="plazo-despues"> Después</label>
          </fieldset>
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    let form = activeMapping(created.import, '', 'perfil_medico')
    const activeFields = form.fields.filter(field => field.present !== false)
    assert.deepEqual(
      activeFields.map(field => [field.fieldId, field.hasStableFieldId]),
      [
        ['rol_decision', false],
        ['estado_consultorio', false],
        ['especialidad', true],
        ['plazo_implementacion', false]
      ]
    )
    assert.deepEqual(mappingField(form, 'rol_decision').options.map(option => option.value), [
      'propietario',
      'director',
      'sin_decision'
    ])

    const sourceForm = await getSite(form.formSiteId, { includeBlocks: true, includeSubmissions: false })
    const importedBlocks = sourceForm.blocks.filter(block => block.settings?.importedHtmlSource === true)
    assert.deepEqual(
      importedBlocks.map(block => [block.blockType, block.label]),
      [
        ['radio', '¿Cuál es tu rol?'],
        ['radio', '¿En qué estado está tu consultorio?'],
        ['dropdown', 'Especialidad'],
        ['radio', '¿Cuándo quieres implementarlo?']
      ]
    )

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'perfil_medico',
      fieldId: 'rol_decision',
      destinationType: 'standard',
      destinationKey: 'message'
    })
    const configured = await getImportedSiteBySiteId(siteId)
    form = activeMapping(configured, '', 'perfil_medico')
    const detectedForm = configured.detectedForms.find(candidate => candidate.id === 'perfil_medico')
    const detectedRole = detectedForm.fields.find(field => field.id === 'rol_decision')
    const mappedRole = mappingField(form, 'rol_decision')
    const explodedRoleIds = ['rol_propietario_socio', 'rol_director_decisor', 'rol_sin_decision']
    const legacyDetectedForms = configured.detectedForms.map(candidate => (
      candidate.id !== 'perfil_medico'
        ? candidate
        : {
            ...candidate,
            fields: candidate.fields.flatMap(field => (
              field.id !== 'rol_decision'
                ? [field]
                : explodedRoleIds.map(id => ({
                    ...detectedRole,
                    id,
                    hasStableFieldId: true
                  }))
            ))
          }
    ))
    const legacyMappings = configured.formMappings.map(candidate => (
      candidate.formId !== 'perfil_medico' || candidate.present === false
        ? candidate
        : {
            ...candidate,
            fields: candidate.fields.flatMap(field => (
              field.fieldId !== 'rol_decision' || field.present === false
                ? [field]
                : explodedRoleIds.map(fieldId => ({
                    ...mappedRole,
                    fieldId,
                    hasStableFieldId: true
                  }))
            ))
          }
    ))
    await db.run(`
      UPDATE public_site_imports SET
        detected_forms_json = ?,
        form_mappings_json = ?,
        status = 'mapping_pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE site_id = ?
    `, [JSON.stringify(legacyDetectedForms), JSON.stringify(legacyMappings), siteId])

    const normalized = await getImportedSiteBySiteId(siteId)
    form = activeMapping(normalized, '', 'perfil_medico')
    assert.equal(form.fields.filter(field => field.present !== false).length, 4)
    assertIncludes(mappingField(form, 'rol_decision'), {
      destinationType: 'standard',
      destinationKey: 'message',
      hasStableFieldId: false,
      present: true
    })
    assert.equal(
      form.fields.filter(field => explodedRoleIds.includes(field.fieldId) && field.present === false).length,
      3
    )

    const persistedRow = await db.get(
      'SELECT detected_forms_json, form_mappings_json FROM public_site_imports WHERE site_id = ?',
      [siteId]
    )
    const persistedDetected = JSON.parse(persistedRow.detected_forms_json)
    const persistedMappings = JSON.parse(persistedRow.form_mappings_json)
    assert.equal(persistedDetected[0].fields.length, 4)
    assert.equal(
      persistedMappings[0].fields.filter(field => field.present !== false).length,
      4
    )
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('a legacy choice group on a secondary HTML page can be associated without dropping the rest of the import', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'flujo-multipagina.html',
      name: `Grupo secundario HTML ${suffix}`,
      siteType: 'landing_page',
      pages: [
        {
          id: 'inicio',
          title: 'Inicio',
          filename: 'inicio.html',
          html: '<!doctype html><html><body><h1>Inicio</h1></body></html>'
        },
        {
          id: 'perfil',
          title: 'Perfil',
          filename: 'perfil.html',
          html: `<!doctype html><html><body>
            <form data-rstk-form-id="prioridad-contacto" data-rstk-label="Prioridad">
              <fieldset>
                <legend>Prioridad de implementación</legend>
                <label><input type="radio" name="prioridad" value="alta" data-rstk-field-id="prioridad-alta"> Alta</label>
                <label><input type="radio" name="prioridad" value="media" data-rstk-field-id="prioridad-media"> Media</label>
                <label><input type="radio" name="prioridad" value="baja" data-rstk-field-id="prioridad-baja"> Baja</label>
              </fieldset>
              <button type="submit">Enviar</button>
            </form>
          </body></html>`
        }
      ]
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId).filter(Boolean))

    const canonicalForm = activeMapping(created.import, 'perfil.html', 'prioridad_contacto')
    const canonicalDetectedForm = created.import.detectedForms.find(form => form.id === 'prioridad_contacto')
    const canonicalField = mappingField(canonicalForm, 'prioridad')
    const canonicalDetectedField = canonicalDetectedForm.fields.find(field => field.id === 'prioridad')
    const explodedIds = ['prioridad_alta', 'prioridad_media', 'prioridad_baja']
    const legacyDetectedForms = created.import.detectedForms.map(form => (
      form.id !== 'prioridad_contacto'
        ? form
        : {
            ...form,
            fields: explodedIds.map(id => ({
              ...canonicalDetectedField,
              id,
              hasStableFieldId: true
            }))
          }
    ))
    const legacyMappings = created.import.formMappings.map(form => (
      form.formId !== 'prioridad_contacto'
        ? form
        : {
            ...form,
            fields: explodedIds.map(fieldId => ({
              ...canonicalField,
              fieldId,
              hasStableFieldId: true
            }))
          }
    ))
    await db.run(`
      UPDATE public_site_imports SET
        detected_forms_json = ?,
        form_mappings_json = ?,
        status = 'mapping_pending',
        updated_at = CURRENT_TIMESTAMP
      WHERE site_id = ?
    `, [JSON.stringify(legacyDetectedForms), JSON.stringify(legacyMappings), siteId])

    const live = await getImportedSiteBySiteId(siteId)
    assert.equal(
      activeMapping(live, 'perfil.html', 'prioridad_contacto').fields.filter(field => field.present !== false).length,
      1
    )
    const beforePatchRow = await db.get(
      'SELECT form_mappings_json FROM public_site_imports WHERE site_id = ?',
      [siteId]
    )
    assert.equal(
      JSON.parse(beforePatchRow.form_mappings_json)[0].fields.filter(field => field.present !== false).length,
      3,
      'la autodetección de la página principal no debe borrar formularios de otra página'
    )

    const patched = await updateImportedSiteFieldMapping(siteId, {
      pagePath: 'perfil.html',
      formId: 'prioridad_contacto',
      fieldId: 'prioridad',
      destinationType: 'standard',
      destinationKey: 'message'
    })
    const patchedForm = activeMapping(patched, 'perfil.html', 'prioridad_contacto')
    assert.equal(patchedForm.fields.filter(field => field.present !== false).length, 1)
    assertIncludes(mappingField(patchedForm, 'prioridad'), {
      destinationType: 'standard',
      destinationKey: 'message',
      present: true
    })
    assert.equal(
      patchedForm.fields.filter(field => explodedIds.includes(field.fieldId) && field.present === false).length,
      3
    )
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('radio and checkbox groups stay as one field and stable-id changes create a new mapping', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'opciones-estables.html',
      name: `Opciones HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="perfil-lead" data-rstk-label="Perfil">
          <label><input type="radio" name="plan" value="starter" data-rstk-field-id="plan-elegido"> Starter</label>
          <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan-elegido"> Pro</label>
          <label><input type="checkbox" name="intereses" value="ventas" data-rstk-field-id="intereses"> Ventas</label>
          <label><input type="checkbox" name="intereses" value="soporte" data-rstk-field-id="intereses"> Soporte</label>
          <input type="email" name="email" data-rstk-field-id="correo-principal">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    let form = activeMapping(created.import, '', 'perfil_lead')
    assert.equal(form.fields.filter(field => field.present !== false).length, 3)
    assert.deepEqual(mappingField(form, 'plan_elegido').options.map(option => option.value), ['starter', 'pro'])
    assert.deepEqual(mappingField(form, 'intereses').options.map(option => option.value), ['ventas', 'soporte'])

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'perfil_lead',
      fieldId: 'plan_elegido',
      destinationType: 'standard',
      destinationKey: 'message'
    })

    const rewritten = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: `<!doctype html><html><body>
          <form data-rstk-form-id="perfil-lead" data-rstk-label="Perfil">
            <label><input type="radio" name="plan" value="starter" data-rstk-field-id="plan-elegido"> Starter</label>
            <label><input type="radio" name="plan" value="pro" data-rstk-field-id="plan-elegido"> Pro</label>
            <input type="email" name="email" data-rstk-field-id="correo-alterno">
            <button type="submit">Enviar</button>
          </form>
        </body></html>`
      }]
    })

    form = activeMapping(rewritten.import, '', 'perfil_lead')
    assertIncludes(mappingField(form, 'plan_elegido'), {
      destinationType: 'standard',
      destinationKey: 'message',
      present: true
    })
    assert.equal(mappingField(form, 'correo_principal').present, false)
    assertIncludes(mappingField(form, 'correo_alterno'), {
      destinationType: 'standard',
      destinationKey: 'email',
      present: true
    })
  } finally {
    if (siteId) {
      const imported = await getImportedSiteBySiteId(siteId).catch(() => null)
      sourceFormIds.push(...(imported?.formMappings || []).map(mapping => mapping.formSiteId))
    }
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('duplicate explicit form ids remain ambiguous instead of being silently renamed', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  const sourceFormIds = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'formularios-duplicados.html',
      name: `Duplicados HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-duplicado">
          <input name="email" data-rstk-field-id="correo-uno"><button type="submit">Uno</button>
        </form>
        <form data-rstk-form-id="lead-duplicado">
          <input name="phone" data-rstk-field-id="telefono-dos"><button type="submit">Dos</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))

    assert.deepEqual(created.import.formMappings.map(mapping => mapping.formId), ['lead_duplicado', 'lead_duplicado'])
    assert.doesNotMatch(created.import.htmlSanitized, /lead_duplicado_2/)
    assert.ok(created.import.formMappings.every(mapping => mapping.mappingAmbiguous === true))
    assert.ok(created.import.formMappings.every(mapping => !mapping.formSiteId))
    await assert.rejects(
      () => updateImportedSiteFieldMapping(siteId, {
        pagePath: '',
        formId: 'lead_duplicado',
        fieldId: 'correo_uno',
        destinationType: 'standard',
        destinationKey: 'email'
      }),
      error => error?.status === 409
    )
  } finally {
    await deleteSites([siteId, ...sourceFormIds])
  }
})

test('a temporary duplicate keeps the canonical association dormant and restores it when the id is unique again', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  let sourceFormId = ''

  const uniqueHtml = (sourceName = 'email') => `<!doctype html><html><body>
    <form data-rstk-form-id="lead-estable" data-rstk-label="Lead estable">
      <input name="${sourceName}" data-rstk-field-id="dato-principal">
      <button type="submit">Enviar</button>
    </form>
  </body></html>`

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'duplicado-temporal.html',
      name: `Duplicado temporal ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(uniqueHtml(), 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormId = created.import.formMappings[0].formSiteId || ''

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'lead_estable',
      fieldId: 'dato_principal',
      destinationType: 'standard',
      destinationKey: 'phone'
    })

    const duplicated = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: uniqueHtml().replace('</body>', `
          <form data-rstk-form-id="lead-estable" data-rstk-label="Copia accidental">
            <input name="email_copia" data-rstk-field-id="correo-copia">
            <button type="submit">Enviar copia</button>
          </form>
        </body>`)
      }]
    })
    const ambiguous = duplicated.import.formMappings.filter(mapping => mapping.present !== false)
    const canonicalBackup = duplicated.import.formMappings.find(mapping => (
      mapping.present === false && mapping.formId === 'lead_estable' && mapping.formSiteId === sourceFormId
    ))
    assert.equal(ambiguous.length, 2)
    assert.ok(ambiguous.every(mapping => mapping.mappingAmbiguous === true && !mapping.formSiteId))
    assertIncludes(mappingField(canonicalBackup, 'dato_principal'), {
      destinationType: 'standard',
      destinationKey: 'phone',
      present: false
    })

    const restored = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: uniqueHtml('telefono_actualizado') }]
    })
    const restoredForm = activeMapping(restored.import, '', 'lead_estable')
    assert.equal(restored.import.formMappings.filter(mapping => mapping.formId === 'lead_estable').length, 1)
    assert.equal(restoredForm.formSiteId, sourceFormId)
    assertIncludes(mappingField(restoredForm, 'dato_principal'), {
      sourceName: 'telefono_actualizado',
      destinationType: 'standard',
      destinationKey: 'phone',
      present: true
    })
  } finally {
    await deleteSites([siteId, sourceFormId])
  }
})

test('duplicate stable field ids quarantine the whole form and restore its canonical mapping after resolution', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''
  let sourceFormId = ''

  const uniqueHtml = (sourceName = 'company') => `<!doctype html><html><body>
    <form data-rstk-form-id="lead-fields" data-rstk-label="Lead con campos estables">
      <label>Empresa <input name="${sourceName}" data-rstk-field-id="company-value"></label>
      <label>Correo <input name="email" type="email" data-rstk-field-id="email-value"></label>
      <button type="submit">Enviar</button>
    </form>
  </body></html>`

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'campo-duplicado-temporal.html',
      name: `Campo duplicado temporal ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(uniqueHtml(), 'utf8').toString('base64')
    })
    siteId = created.site.id
    sourceFormId = created.import.formMappings[0].formSiteId || ''
    assert.ok(sourceFormId)

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'lead_fields',
      fieldId: 'company_value',
      destinationType: 'standard',
      destinationKey: 'phone'
    })
    const sourceBefore = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: false })

    const duplicated = await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: `<!doctype html><html><body>
          <form data-rstk-form-id="lead-fields" data-rstk-label="Lead con campos estables">
            <label>Empresa A <input name="company_a" data-rstk-field-id="company-value"></label>
            <label>Empresa B <input name="company_b" data-rstk-field-id="company-value"></label>
            <label>Correo <input name="email" type="email" data-rstk-field-id="email-value"></label>
            <button type="submit">Enviar</button>
          </form>
        </body></html>`
      }]
    })
    const quarantined = activeMapping(duplicated.import, '', 'lead_fields')
    const duplicateFields = quarantined.fields.filter(field => (
      field.present !== false && field.fieldId === 'company_value'
    ))
    const canonicalBackup = quarantined.fields.find(field => (
      field.present === false && field.fieldId === 'company_value'
    ))
    assert.equal(quarantined.fieldMappingAmbiguous, true)
    assert.equal(quarantined.formSiteId, sourceFormId)
    assert.equal(duplicateFields.length, 2)
    assert.ok(duplicateFields.every(field => field.mappingAmbiguous === true))
    assertIncludes(canonicalBackup, {
      destinationType: 'standard',
      destinationKey: 'phone',
      present: false
    })

    await assert.rejects(
      () => updateImportedSiteFieldMapping(siteId, {
        pagePath: '',
        formId: 'lead_fields',
        fieldId: 'email_value',
        destinationType: 'ignored'
      }),
      error => error?.status === 409
    )

    const sourceDuring = await getSite(sourceFormId, { includeBlocks: true, includeSubmissions: false })
    assert.deepEqual(sourceDuring.blocks, sourceBefore.blocks)

    const currentSite = await getSite(siteId, { includeBlocks: true, includeSubmissions: false })
    const publicHtml = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: false
    })
    assert.match(publicHtml, /const FORMS = \[\];/)

    const restored = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: uniqueHtml('company_legal_name') }]
    })
    const restoredForm = activeMapping(restored.import, '', 'lead_fields')
    const restoredField = restoredForm.fields.find(field => (
      field.present !== false && field.fieldId === 'company_value'
    ))
    assert.equal(restoredForm.fieldMappingAmbiguous, undefined)
    assert.equal(restoredForm.formSiteId, sourceFormId)
    assertIncludes(restoredField, {
      sourceName: 'company_legal_name',
      destinationType: 'standard',
      destinationKey: 'phone',
      present: true
    })
  } finally {
    await deleteSites([siteId, sourceFormId])
  }
})

test('an initially duplicated stable field id never creates a source form', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'campo-duplicado-inicial.html',
      name: `Campo duplicado inicial ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-inicial">
          <input name="company_a" data-rstk-field-id="company-value">
          <input name="company_b" data-rstk-field-id="company-value">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    const form = activeMapping(created.import, '', 'lead_inicial')
    assert.equal(form.fieldMappingAmbiguous, true)
    assert.equal(form.formSiteId, undefined)
    assert.equal(form.fields.filter(field => field.present !== false && field.mappingAmbiguous === true).length, 2)
  } finally {
    await deleteSites([siteId])
  }
})

test('data-rstk-form-id is globally unique across pages and PATCH cannot bypass ambiguity with pagePath', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'duplicado-global.html',
      name: `Duplicado global ${suffix}`,
      siteType: 'landing_page',
      pages: [
        {
          id: 'inicio',
          title: 'Inicio',
          filename: 'inicio.html',
          html: '<!doctype html><html><body><form data-rstk-form-id="lead-global"><input name="email" data-rstk-field-id="correo-inicio"><button>Enviar</button></form></body></html>'
        },
        {
          id: 'oferta',
          title: 'Oferta',
          filename: 'oferta.html',
          html: '<!doctype html><html><body><form data-rstk-form-id="lead-global"><input name="phone" data-rstk-field-id="telefono-oferta"><button>Enviar</button></form></body></html>'
        }
      ]
    })
    siteId = created.site.id

    const active = created.import.formMappings.filter(mapping => mapping.present !== false)
    assert.equal(active.length, 2)
    assert.ok(active.every(mapping => mapping.formId === 'lead_global' && mapping.mappingAmbiguous === true))
    await assert.rejects(
      () => updateImportedSiteFieldMapping(siteId, {
        pagePath: 'inicio.html',
        formId: 'lead_global',
        fieldId: 'correo_inicio',
        destinationType: 'standard',
        destinationKey: 'email'
      }),
      error => error?.status === 409
    )
  } finally {
    await deleteSites([siteId])
  }
})
