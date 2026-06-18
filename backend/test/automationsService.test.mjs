import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createAutomation,
  getAutomation,
  listAttributionAdsets,
  listAttributionAds,
  listAttributionCampaigns,
  listAutomationFormFieldsCatalog,
  listAutomationFormsCatalog,
  updateAutomation
} from '../src/services/automationsService.js'

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
        type: 'action-send-message',
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
