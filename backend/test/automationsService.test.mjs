import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import {
  createAutomation,
  getAutomation,
  listAttributionAdsets,
  listAttributionAds,
  listAttributionCampaigns,
  listAutomationFormFieldsCatalog,
  listAutomationFormsCatalog,
  listAutomationWhatsAppTemplatesCatalog,
  listAutomations,
  testAutomationRun,
  updateAutomation
} from '../src/services/automationsService.js'
import { getWhatsAppApiConfigKeys } from '../src/services/whatsappApiService.js'

async function withAppConfigValue(key, value, callback) {
  const previous = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [key])

  try {
    await setAppConfig(key, value)
    return await callback()
  } finally {
    if (previous) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [key, previous.config_value])
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
    }
  }
}

function makeFlow(label = 'Mensaje publicado', viewport = { x: 0, y: 0, zoom: 1 }) {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{ id: 'trig_test', type: 'trigger-contact-created', config: {} }]
        }
      },
      {
        id: 'node_message',
        type: 'channel-whatsapp',
        label: 'Mensaje',
        position: { x: 520, y: 220 },
        config: { customTitle: label }
      }
    ],
    edges: [
      {
        id: 'edge_test',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: 'node_message',
        targetHandle: 'in',
        animated: true
      }
    ],
    viewport,
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }
}

function makeTagTriggerFlow(tagId, tagName = tagId) {
  const flow = makeFlow('Mensaje con etiqueta')
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === 'start'
        ? {
            ...node,
            config: {
              triggers: [{
                id: 'trig_tag_test',
                type: 'trigger-contact-tag',
                config: { tag: tagId, tagName }
              }]
            }
          }
        : node
    )
  }
}

function makeTagActionFlow(tagId) {
  const actionNodeId = 'node_add_tag'
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{ id: 'trig_test_run', type: 'trigger-contact-created', config: {} }]
        }
      },
      {
        id: actionNodeId,
        type: 'action-add-contact-tag',
        label: 'Añadir etiqueta',
        position: { x: 520, y: 220 },
        config: { tag: tagId }
      }
    ],
    edges: [
      {
        id: 'edge_test_run',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: actionNodeId,
        targetHandle: 'in',
        animated: true
      }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }
}

test('updateAutomation separa borrador guardado de flujo publicado', async () => {
  const automation = await createAutomation({
    name: `Publicación con borrador ${Date.now()}`,
    flow: makeFlow('Versión viva')
  })

  try {
    const published = await updateAutomation(automation.id, { status: 'published' })
    assert.equal(published.status, 'published')
    assert.equal(published.hasUnpublishedChanges, false)

    const movedViewport = await updateAutomation(automation.id, {
      flow: makeFlow('Versión viva', { x: 200, y: -40, zoom: 0.8 })
    })
    assert.equal(movedViewport.hasUnpublishedChanges, false)

    const draftSaved = await updateAutomation(automation.id, {
      flow: makeFlow('Cambio pendiente')
    })
    assert.equal(draftSaved.status, 'published')
    assert.equal(draftSaved.hasUnpublishedChanges, true)

    const rowWithDraft = await db.get('SELECT flow, published_flow FROM automations WHERE id = ?', [automation.id])
    assert.match(String(rowWithDraft.flow), /Cambio pendiente/)
    assert.match(String(rowWithDraft.published_flow), /Versión viva/)

    const republished = await updateAutomation(automation.id, { status: 'published' })
    assert.equal(republished.hasUnpublishedChanges, false)

    const fresh = await getAutomation(automation.id)
    assert.equal(fresh.hasUnpublishedChanges, false)
    assert.equal(fresh.flow.nodes[1].config.customTitle, 'Cambio pendiente')
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id])
  }
})

test('testAutomationRun inscribe un contacto real como prueba y devuelve bitácora', async () => {
  const suffix = Date.now()
  const tagId = `tag_test_run_${suffix}`
  const contactId = `contact_test_run_${suffix}`
  let automation

  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Prueba automatización'])
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, phone, email, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, 'Contacto Prueba', 'Contacto', `+521555${suffix}`, `test-run-${suffix}@example.com`]
  )

  try {
    automation = await createAutomation({
      name: `Prueba runner ${suffix}`,
      flow: makeTagActionFlow(tagId)
    })
    await updateAutomation(automation.id, { status: 'published' })

    const result = await testAutomationRun(automation.id, { contactId })
    const contact = await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])
    const tags = JSON.parse(contact.tags || '[]')

    assert.equal(result.mode, 'test')
    assert.equal(result.automationId, automation.id)
    assert.equal(result.contactId, contactId)
    assert.equal(result.enrollment.automationName, `Prueba runner ${suffix}`)
    assert.ok(result.enrollment.log.some((entry) => entry.detail === 'Prueba iniciada desde Automatizaciones'))
    assert.ok(tags.includes(tagId))
  } finally {
    if (automation?.id) {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automation.id]).catch(() => undefined)
      await db.run('DELETE FROM automations WHERE id = ?', [automation.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId]).catch(() => undefined)
  }
})

test('updateAutomation bloquea publicación cuando una referencia ya no existe', async () => {
  const suffix = Date.now()
  const missingTagId = `tag_missing_review_${suffix}`
  const automation = await createAutomation({
    name: `Referencia rota ${suffix}`,
    flow: makeTagTriggerFlow(missingTagId, 'Etiqueta eliminada')
  })

  try {
    await assert.rejects(
      () => updateAutomation(automation.id, { status: 'published' }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /La etiqueta "Etiqueta eliminada" ya no existe/)
        assert.ok(error.validationErrors.some((message) => /Selecciona otra etiqueta/.test(message)))
        return true
      }
    )
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id])
  }
})

test('automatización publicada queda en requires_review si se elimina una referencia usada', async () => {
  const suffix = Date.now()
  const tagId = `tag_review_${suffix}`
  const automationName = `Automatización rota ${suffix}`

  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Etiqueta temporal'])
  const automation = await createAutomation({
    name: automationName,
    flow: makeTagTriggerFlow(tagId, 'Etiqueta temporal')
  })

  try {
    const published = await updateAutomation(automation.id, { status: 'published' })
    assert.equal(published.reviewStatus.state, 'ok')

    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId])

    const fresh = await getAutomation(automation.id)
    assert.equal(fresh.reviewStatus.state, 'requires_review')
    assert.equal(fresh.reviewStatus.issueCount, 1)
    assert.match(fresh.reviewStatus.summary, /La etiqueta "Etiqueta temporal" ya no existe/)

    const listed = await listAutomations()
    const listedAutomation = listed.find((item) => item.id === automation.id)
    assert.equal(listedAutomation?.reviewStatus?.state, 'requires_review')
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id])
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId]).catch(() => undefined)
  }
})

test('catálogos de Meta Ads devuelven campañas, conjuntos y anuncios reales', async () => {
  const suffix = Date.now()
  const accountId = `act_catalog_${suffix}`
  const campaignId = `cmp_${suffix}`
  const adsetId = `adset_${suffix}`
  const adId = `ad_${suffix}`

  await db.run(
    `INSERT INTO meta_ads (
       date,
       ad_account_id,
       campaign_id,
       campaign_name,
       adset_id,
       adset_name,
       ad_id,
       ad_name,
       spend,
       clicks
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      '2099-01-01',
      accountId,
      campaignId,
      'Campaña de prueba',
      adsetId,
      'Conjunto de prueba',
      adId,
      'Anuncio de prueba',
      10,
      3
    ]
  )

  try {
    const [campaigns, adsets, ads] = await Promise.all([
      listAttributionCampaigns(),
      listAttributionAdsets(),
      listAttributionAds()
    ])

    assert.ok(campaigns.some((campaign) => (
      campaign.id === campaignId &&
      campaign.name === 'Campaña de prueba' &&
      campaign.lastDate === '2099-01-01'
    )))
    assert.ok(adsets.some((adset) => (
      adset.id === adsetId &&
      adset.name === 'Conjunto de prueba' &&
      adset.campaignId === campaignId &&
      adset.campaignName === 'Campaña de prueba'
    )))
    assert.ok(ads.some((ad) => (
      ad.id === adId &&
      ad.name === 'Anuncio de prueba' &&
      ad.adsetId === adsetId &&
      ad.adsetName === 'Conjunto de prueba' &&
      ad.campaignId === campaignId
    )))
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId])
  }
})

test('catálogo de plantillas WhatsApp para automatizaciones devuelve aprobadas con componentes', async () => {
  const suffix = Date.now()
  const approvedId = `wa_tpl_approved_${suffix}`
  const pendingId = `wa_tpl_pending_${suffix}`
  const approvedName = `recordatorio_cita_${suffix}`
  const pendingName = `plantilla_pendiente_${suffix}`
  const components = [
    { type: 'BODY', text: 'Hola {{1}}, tu cita está lista.' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar' }] }
  ]

  await db.run(
    `INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
    [
      approvedId,
      `official_${approvedId}`,
      'waba_catalog_test',
      approvedName,
      'es_MX',
      JSON.stringify(components),
      '{}'
    ]
  )
  await db.run(
    `INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    [
      pendingId,
      `official_${pendingId}`,
      'waba_catalog_test',
      pendingName,
      'es_MX',
      JSON.stringify([{ type: 'BODY', text: 'Pendiente' }]),
      '{}'
    ]
  )

  try {
    const catalog = await listAutomationWhatsAppTemplatesCatalog()
    const item = catalog.items.find((template) => template.id === approvedId)

    assert.ok(item)
    assert.equal(item.name, approvedName)
    assert.equal(item.language, 'es_MX')
    assert.deepEqual(item.components, components)
    assert.ok(!catalog.items.some((template) => template.id === pendingId))
  } finally {
    await db.run('DELETE FROM whatsapp_api_templates WHERE id IN (?, ?)', [approvedId, pendingId])
  }
})

test('catálogo de plantillas WhatsApp refleja plantillas locales aprobadas', async () => {
  const suffix = Date.now()
  const keys = getWhatsAppApiConfigKeys()
  const templateId = `tmpl_local_catalog_${suffix}`
  const officialId = `official_local_catalog_${suffix}`
  const templateName = `seguimiento_local_${suffix}`
  const wabaId = 'waba_catalog_local_test'
  const buttons = [{ id: `btn_${suffix}`, type: 'quick_reply', label: 'Agendar', value: '' }]
  const expectedComponents = [
    { type: 'BODY', text: 'Hola {{1}}, tenemos cupo para tu cita.' },
    { type: 'FOOTER', text: 'Responde cuando puedas' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Agendar' }] }
  ]

  await withAppConfigValue(keys.wabaId, wabaId, async () => {
    try {
      await db.run(`
        INSERT INTO whatsapp_message_templates (
          id, name, description, category, language, status,
          header_enabled, header_type, body_text, footer_text, buttons_json,
          variables_json, variable_examples_json, variable_bindings_json,
          ycloud_template_id, ycloud_status, ycloud_raw_payload_json,
          created_at, updated_at
        ) VALUES (?, ?, '', 'utility', 'es_MX', 'active', 0, 'none', ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        templateId,
        templateName,
        'Hola {{1}}, tenemos cupo para tu cita.',
        'Responde cuando puedas',
        JSON.stringify(buttons),
        JSON.stringify(['{{1}}']),
        JSON.stringify({ '{{1}}': 'Ana' }),
        JSON.stringify({ bodyText: { 1: { variableKey: 'contact.first_name', mergeField: '{{contact.first_name}}', label: 'Nombre', example: 'Ana' } } }),
        officialId,
        JSON.stringify({ id: officialId, status: 'APPROVED' })
      ])

      const catalog = await listAutomationWhatsAppTemplatesCatalog()
      const item = catalog.items.find((template) => template.id === officialId)

      assert.ok(item)
      assert.equal(item.name, templateName)
      assert.equal(item.language, 'es_MX')
      assert.equal(item.status, 'APPROVED')
      assert.deepEqual(item.components, expectedComponents)
    } finally {
      await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ? AND name = ? AND language = ?', [wabaId, templateName, 'es_MX'])
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [templateId])
    }
  })
})

test('catálogo WhatsApp oculta nombres técnicos de reintento y no duplica plantillas locales', async () => {
  const suffix = Date.now()
  const keys = getWhatsAppApiConfigKeys()
  const templateId = `tmpl_retry_catalog_${suffix}`
  const officialBaseId = `official_retry_catalog_base_${suffix}`
  const officialRetryId = `official_retry_catalog_retry_${suffix}`
  const templateName = `recordatorio_retry_catalog_${suffix}`
  const retryName = `${templateName}_r1`
  const wabaId = 'waba_catalog_retry_alias_test'
  const components = [
    { type: 'BODY', text: 'Hola {{1}}, confirma tu cita.' },
    { type: 'FOOTER', text: 'Mensaje automático de Ristak' }
  ]

  await withAppConfigValue(keys.wabaId, wabaId, async () => {
    try {
      await db.run(`
        INSERT INTO whatsapp_message_templates (
          id, name, description, category, language, status,
          header_enabled, header_type, body_text, footer_text, buttons_json,
          variables_json, variable_examples_json, variable_bindings_json,
          ycloud_template_name, ycloud_template_id, ycloud_status, ycloud_raw_payload_json,
          created_at, updated_at
        ) VALUES (?, ?, '', 'utility', 'es_MX', 'active', 0, 'none', ?, ?, '[]', ?, ?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        templateId,
        templateName,
        'Hola {{1}}, confirma tu cita.',
        'Mensaje automático de Ristak',
        JSON.stringify(['{{1}}']),
        JSON.stringify({ '{{1}}': 'Ana' }),
        JSON.stringify({ bodyText: { 1: { variableKey: 'contact.first_name', mergeField: '{{contact.first_name}}', label: 'Nombre', example: 'Ana' } } }),
        retryName,
        officialRetryId,
        JSON.stringify({ id: officialRetryId, name: retryName, status: 'APPROVED' })
      ])

      await db.run(`
        INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json, updated_at
        ) VALUES (?, ?, ?, ?, 'es_MX', 'APPROVED', ?, '{}', datetime('now', '-1 hour'))
      `, [officialBaseId, officialBaseId, wabaId, templateName, JSON.stringify(components)])

      await db.run(`
        INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json, updated_at
        ) VALUES (?, ?, ?, ?, 'es_MX', 'APPROVED', ?, '{}', CURRENT_TIMESTAMP)
      `, [officialRetryId, officialRetryId, wabaId, retryName, JSON.stringify(components)])

      const catalog = await listAutomationWhatsAppTemplatesCatalog()
      const matches = catalog.items.filter((template) => template.name === templateName && template.language === 'es_MX')

      assert.equal(matches.length, 1)
      assert.equal(matches[0].id, officialRetryId)
      assert.equal(matches[0].name, templateName)
      assert.equal(matches[0].official_name, retryName)
      assert.ok(!catalog.items.some((template) => String(template.name).includes('_r1')))
    } finally {
      await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ? AND name IN (?, ?)', [wabaId, templateName, retryName])
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [templateId])
    }
  })
})

test('catálogo de formularios para automatizaciones incluye normales, embebidos e importados', async () => {
  const suffix = Date.now()
  const formSiteId = `site_form_catalog_${suffix}`
  const landingSiteId = `site_landing_catalog_${suffix}`
  const linkedFormSiteId = `site_linked_form_catalog_${suffix}`
  const importedSiteId = `site_imported_catalog_${suffix}`
  const blockId = `block_form_catalog_${suffix}`
  const linkedBlockId = `block_linked_form_catalog_${suffix}`
  const importId = `import_catalog_${suffix}`
  const importedLeadFormId = `lead_form_${suffix}`
  const importedCheckoutFormId = `checkout_form_${suffix}`

  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [formSiteId, 'Formulario directo', `formulario-directo-${suffix}`, 'standard_form']
  )
  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [landingSiteId, 'Landing con formulario', `landing-formulario-${suffix}`, 'landing_page']
  )
  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [linkedFormSiteId, 'Formulario guardado real', `formulario-guardado-real-${suffix}`, 'landing_page']
  )
  await db.run(
    `INSERT INTO public_site_blocks (id, site_id, block_type, label, settings_json, sort_order)
     VALUES (?, ?, 'form_embed', ?, ?, 1)`,
    [
      blockId,
      landingSiteId,
      'Solicitud interna',
      JSON.stringify({ formSiteName: 'Solicitud interna' })
    ]
  )
  await db.run(
    `INSERT INTO public_site_blocks (id, site_id, block_type, label, settings_json, sort_order)
     VALUES (?, ?, 'form_embed', ?, ?, 2)`,
    [
      linkedBlockId,
      landingSiteId,
      '¿Cuál es tu presupuesto?',
      JSON.stringify({ formSiteId: linkedFormSiteId })
    ]
  )
  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [importedSiteId, 'Landing importada', `landing-importada-${suffix}`, 'landing_page']
  )
  await db.run(
    `INSERT INTO public_site_imports (
       id, site_id, original_filename, html_sanitized, detected_forms_json,
       form_mappings_json, security_report_json, status
     ) VALUES (?, ?, ?, ?, '[]', ?, '[]', 'ready')`,
    [
      importId,
      importedSiteId,
      'landing.html',
      '<form></form>',
      JSON.stringify([
        { formId: importedLeadFormId, formTitle: 'Formulario de lead', fields: [] },
        { formId: importedCheckoutFormId, formTitle: 'Formulario de pago', fields: [] }
      ])
    ]
  )

  try {
    const forms = await listAutomationFormsCatalog()
    const ids = new Set(forms.map((form) => form.id))

    assert.ok(ids.has(formSiteId))
    assert.ok(ids.has(`${landingSiteId}:form_embed:${blockId}`))
    assert.ok(forms.some((form) => form.id === linkedFormSiteId && form.name === 'Formulario guardado real'))
    assert.ok(ids.has(`${importedSiteId}:imported:${importedLeadFormId}`))
    assert.ok(ids.has(`${importedSiteId}:imported:${importedCheckoutFormId}`))
    assert.ok(forms.some((form) => form.id === `${importedSiteId}:imported:${importedLeadFormId}` && form.name === 'Formulario de lead'))
  } finally {
    await db.run('DELETE FROM public_site_imports WHERE id = ?', [importId])
    await db.run('DELETE FROM public_site_blocks WHERE id IN (?, ?)', [blockId, linkedBlockId])
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?, ?, ?)', [formSiteId, landingSiteId, linkedFormSiteId, importedSiteId])
  }
})

test('catálogo de preguntas de formulario usa el ID del formulario elegido', async () => {
  const suffix = Date.now()
  const formSiteId = `site_form_fields_catalog_${suffix}`
  const landingSiteId = `site_landing_fields_catalog_${suffix}`
  const importedSiteId = `site_imported_fields_catalog_${suffix}`
  const directBudgetFieldId = `field_budget_${suffix}`
  const directNeedFieldId = `field_need_${suffix}`
  const inlineBlockId = `block_inline_form_${suffix}`
  const inlineFieldId = `field_inline_${suffix}`
  const importId = `import_fields_${suffix}`
  const importedLeadFormId = `lead_form_fields_${suffix}`

  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [formSiteId, 'Formulario con preguntas', `formulario-preguntas-${suffix}`, 'standard_form']
  )
  await db.run(
    `INSERT INTO public_site_blocks (id, site_id, block_type, label, settings_json, sort_order)
     VALUES (?, ?, 'number', ?, ?, 1)`,
    [
      directBudgetFieldId,
      formSiteId,
      '¿Cuál es tu presupuesto mensual?',
      JSON.stringify({ customFieldKey: 'presupuesto_mensual' })
    ]
  )
  await db.run(
    `INSERT INTO public_site_blocks (id, site_id, block_type, label, settings_json, sort_order)
     VALUES (?, ?, 'paragraph', ?, '{}', 2)`,
    [directNeedFieldId, formSiteId, '¿Qué necesitas resolver?']
  )
  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [landingSiteId, 'Landing con formulario interno', `landing-formulario-interno-${suffix}`, 'landing_page']
  )
  await db.run(
    `INSERT INTO public_site_blocks (id, site_id, block_type, label, settings_json, sort_order)
     VALUES (?, ?, 'form_embed', ?, ?, 1)`,
    [
      inlineBlockId,
      landingSiteId,
      '¿Pregunta que no debe ser formulario?',
      JSON.stringify({
        embeddedBlocks: [
          {
            id: inlineFieldId,
            blockType: 'short_text',
            label: 'Pregunta interna',
            settings: { internalName: 'pregunta_interna' }
          }
        ]
      })
    ]
  )
  await db.run(
    `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
     VALUES (?, ?, ?, ?, 'published', '{}', CURRENT_TIMESTAMP)`,
    [importedSiteId, 'Landing importada con campos', `landing-importada-campos-${suffix}`, 'landing_page']
  )
  await db.run(
    `INSERT INTO public_site_imports (
       id, site_id, original_filename, html_sanitized, detected_forms_json,
       form_mappings_json, security_report_json, status
     ) VALUES (?, ?, ?, ?, '[]', ?, '[]', 'ready')`,
    [
      importId,
      importedSiteId,
      'landing-fields.html',
      '<form></form>',
      JSON.stringify([
        {
          formId: importedLeadFormId,
          formTitle: 'Lead importado',
          fields: [
            { sourceName: 'monthly_budget', label: 'Presupuesto importado', type: 'number' }
          ]
        }
      ])
    ]
  )

  try {
    const directFields = await listAutomationFormFieldsCatalog(formSiteId)
    assert.ok(directFields.some((field) => (
      field.id === 'presupuesto_mensual' &&
      field.name === '¿Cuál es tu presupuesto mensual?' &&
      field.type === 'number'
    )))
    assert.ok(directFields.some((field) => (
      field.id === directNeedFieldId &&
      field.name === '¿Qué necesitas resolver?'
    )))

    const inlineFields = await listAutomationFormFieldsCatalog(`${landingSiteId}:form_embed:${inlineBlockId}`)
    assert.deepEqual(
      inlineFields.map((field) => ({ id: field.id, name: field.name })),
      [{ id: 'pregunta_interna', name: 'Pregunta interna' }]
    )

    const importedFields = await listAutomationFormFieldsCatalog(`${importedSiteId}:imported:${importedLeadFormId}`)
    assert.deepEqual(
      importedFields.map((field) => ({ id: field.id, name: field.name, type: field.type })),
      [{ id: 'monthly_budget', name: 'Presupuesto importado', type: 'number' }]
    )
  } finally {
    await db.run('DELETE FROM public_site_imports WHERE id = ?', [importId])
    await db.run('DELETE FROM public_site_blocks WHERE id IN (?, ?, ?)', [directBudgetFieldId, directNeedFieldId, inlineBlockId])
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?, ?)', [formSiteId, landingSiteId, importedSiteId])
  }
})
