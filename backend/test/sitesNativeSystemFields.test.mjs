import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { createBlock, createSite, createSubmissionFromRequest, deleteSite, renderPublicSiteHtml, restoreBlocks } from '../src/services/sitesService.js'
import { parseContactCustomFields } from '../src/utils/contactCustomFields.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

async function waitForAutomationEnrollments(automationIds, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const placeholders = automationIds.map(() => '?').join(',')
    const rows = await db.all(
      `SELECT * FROM automation_enrollments WHERE automation_id IN (${placeholders})`,
      automationIds
    )
    if (rows.length >= automationIds.length) return rows
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const placeholders = automationIds.map(() => '?').join(',')
  return db.all(
    `SELECT * FROM automation_enrollments WHERE automation_id IN (${placeholders})`,
    automationIds
  )
}

test('native form system fields save to contact and locked system fields', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const previousCityDefinition = await db.get(
    'SELECT id FROM contact_custom_field_definitions WHERE field_key = ? LIMIT 1',
    ['city']
  )
  const email = `ana-system-${Date.now()}@example.test`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario campos sistema',
      slug: `form-system-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })

    await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Primer nombre',
      placeholder: 'Tu primer nombre',
      required: true,
      settings: { systemFieldKey: 'first_name', internalName: 'first_name' }
    })
    await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      placeholder: 'tu@email.com',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    const siteWithCity = await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Ciudad',
      placeholder: 'Tu ciudad',
      required: false,
      settings: { systemFieldKey: 'city', internalName: 'city', customFieldDataType: 'text' }
    })

    const blocks = siteWithCity.blocks || []
    const firstNameBlock = blocks.find(block => block.settings?.systemFieldKey === 'first_name')
    const emailBlock = blocks.find(block => block.settings?.systemFieldKey === 'email')
    const cityBlock = blocks.find(block => block.settings?.systemFieldKey === 'city')

    assert.ok(firstNameBlock)
    assert.ok(emailBlock)
    assert.ok(cityBlock)

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        finalSubmit: true,
        responses: {
          [firstNameBlock.id]: 'Ana',
          [emailBlock.id]: email,
          [cityBlock.id]: 'CDMX'
        }
      }
    )

    assert.ok(result.contactId)
    assert.equal(result.mappedFields.standard.first_name, 'Ana')
    assert.equal(result.mappedFields.standard.email, email)
    assert.equal(result.mappedFields.system.city, 'CDMX')
    assert.equal(result.mappedFields.custom?.city, undefined)
    assert.equal(result.derivedFields.full_name, 'Ana')

    const contact = await db.get(
      'SELECT email, full_name, first_name, custom_fields FROM contacts WHERE id = ?',
      [result.contactId]
    )
    assert.equal(contact.email, email)
    assert.equal(contact.full_name, 'Ana')
    assert.equal(contact.first_name, 'Ana')

    const customFields = parseContactCustomFields(contact.custom_fields)
    const cityField = customFields.find(field => field.fieldKey === 'city')
    assert.equal(cityField?.value, 'CDMX')
    assert.equal(cityField?.sourceType, 'system')
    assert.equal(cityField?.syncTarget, 'none')

    const cityDefinition = await db.get(
      'SELECT field_key, source_type, sync_target FROM contact_custom_field_definitions WHERE field_key = ? LIMIT 1',
      ['city']
    )
    assert.equal(cityDefinition.field_key, 'city')
    assert.equal(cityDefinition.source_type, 'system')
    assert.equal(cityDefinition.sync_target, 'none')
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    if (!previousCityDefinition?.id) {
      const cityDefinition = await db.get(
        'SELECT id FROM contact_custom_field_definitions WHERE field_key = ? LIMIT 1',
        ['city']
      )
      if (cityDefinition?.id) {
        await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [cityDefinition.id]).catch(() => undefined)
        await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [cityDefinition.id]).catch(() => undefined)
      }
    }
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('native form URL validation renders a real URL validator', async () => {
  let site

  try {
    site = await createSite({
      name: 'Formulario URL',
      slug: `form-url-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })

    const siteWithField = await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Sitio web',
      placeholder: 'https://tusitio.com',
      required: true,
      settings: { internalName: 'website', validation: 'url' }
    })

    const html = await renderPublicSiteHtml(siteWithField, { preview: true })
    assert.match(html, /data-validation="url"/)
    assert.match(html, /type="url"/)
    assert.match(html, /Ingresa una URL válida\./)
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('native phone country selector keeps a bounded readable width', async () => {
  let site

  try {
    site = await createSite({
      name: 'Formulario telefono',
      slug: `form-phone-layout-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })

    const siteWithField = await createBlock(site.id, {
      blockType: 'phone',
      label: 'Telefono / WhatsApp',
      placeholder: '10 digitos',
      required: true,
      settings: { internalName: 'phone', validation: 'phone', phoneCountrySelectorEnabled: true }
    })

    const html = await renderPublicSiteHtml(siteWithField, { preview: true })
    assert.match(html, /class="rstk-phone-input"/)
    assert.match(html, /data-phone-country-select/)
    assert.match(html, /grid-template-columns:minmax\(132px,clamp\(132px,24%,142px\)\) minmax\(0,1fr\)/)
    assert.match(html, /@media \(max-width:640px\)\{[\s\S]*\.rstk-phone-input\{grid-template-columns:minmax\(124px,132px\) minmax\(0,1fr\)\}/)
    assert.match(html, /@media \(max-width:340px\)\{[\s\S]*\.rstk-phone-input\{grid-template-columns:1fr\}/)
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('native form option rules redirect to site pages and external URLs with submit preference', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const slug = `form-rules-${Date.now()}`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario reglas',
      slug,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        pages: [
          { id: 'page-1', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
          { id: 'page-2', title: 'Gracias', slug: 'gracias', sortOrder: 1 }
        ]
      }
    })

    const siteWithField = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Destino',
      required: true,
      settings: { pageId: 'page-1' },
      options: [
        {
          id: 'internal-page',
          label: 'Gracias interna',
          value: 'Gracias interna',
          action: 'site_page',
          targetPageId: 'page-2',
          submitBeforeAction: true
        },
        {
          id: 'external-url',
          label: 'URL externa',
          value: 'URL externa',
          action: 'redirect',
          redirectUrl: 'https://example.com/oferta',
          submitBeforeAction: false
        },
        {
          id: 'not-qualified',
          label: 'No califico',
          value: 'No califico',
          action: 'disqualify_after_submit',
          message: 'No califica por ahora.'
        }
      ]
    })

    const field = siteWithField.blocks.find(block => block.blockType === 'radio')
    assert.ok(field)

    const baseReq = {
      headers: { host: 'example.test', 'user-agent': 'node-test' },
      hostname: 'example.test',
      path: `/${slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }

    const internalResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'Gracias interna'
      }
    })

    assert.equal(internalResult.status, 'received')
    assert.equal(internalResult.redirectUrl, '?page=page-2')
    assert.equal(internalResult.rules.targetPageId, 'page-2')
    assert.equal(internalResult.rules.actions[0].action, 'site_page')
    assert.equal(internalResult.rules.actions[0].submitBeforeAction, true)

    const externalResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'URL externa'
      }
    })

    assert.equal(externalResult.status, 'received')
    assert.equal(externalResult.redirectUrl, 'https://example.com/oferta')
    assert.equal(externalResult.rules.actions[0].action, 'redirect')
    assert.equal(externalResult.rules.actions[0].submitBeforeAction, false)

    const disqualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'No califico'
      }
    })

    assert.equal(disqualifiedResult.status, 'disqualified')
    assert.equal(disqualifiedResult.message, 'No califica por ahora.')
    assert.equal(disqualifiedResult.redirectUrl, '')
    assert.equal(disqualifiedResult.rules.actions[0].action, 'disqualify_after_submit')
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE source = ?', [`ristak_site:${slug}`]).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('native form submission triggers contact and form automations with mappable answers', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = crypto.randomUUID()
  const email = `form-automation-${suffix}@example.test`
  const contactAutomationId = `automation_contact_form_${suffix}`
  const formAutomationId = `automation_form_submit_${suffix}`
  let site

  const doneFlow = (trigger) => ({
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [trigger] }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: `edge-${trigger.id}`, sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: false }
  })

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario automatizaciones',
      slug: `form-automation-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })

    let siteWithBlocks = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    siteWithBlocks = await createBlock(site.id, {
      blockType: 'currency',
      label: 'Presupuesto mensual',
      required: false,
      settings: { internalName: 'presupuesto' }
    })
    siteWithBlocks = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Calificación',
      required: true,
      settings: { internalName: 'calificacion' },
      options: [
        {
          id: 'qualified',
          label: 'Sí califico',
          value: 'Sí califico',
          action: 'continue'
        },
        {
          id: 'not-qualified',
          label: 'No califico',
          value: 'No califico',
          action: 'disqualify_after_submit',
          message: 'No califica por ahora.'
        }
      ]
    })

    const emailBlock = siteWithBlocks.blocks.find(block => block.blockType === 'email')
    const budgetBlock = siteWithBlocks.blocks.find(block => block.label === 'Presupuesto mensual')
    const qualificationBlock = siteWithBlocks.blocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(budgetBlock)
    assert.ok(qualificationBlock)

    const contactFlow = doneFlow({
      id: 'trigger-contact-created',
      type: 'trigger-contact-created',
      config: { source: '' }
    })
    const formFlow = doneFlow({
      id: 'trigger-form-submitted',
      type: 'trigger-form-submitted',
      config: {
        form: site.id,
        filters: [{ field: 'form_disqualified', match: 'is_disqualified', value: '' }]
      }
    })

    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [contactAutomationId, 'Contacto desde formulario', JSON.stringify(contactFlow), JSON.stringify(contactFlow)]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [formAutomationId, 'Formulario descalificado', JSON.stringify(formFlow), JSON.stringify(formFlow)]
    )

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        finalSubmit: true,
        responses: {
          [emailBlock.id]: email,
          [budgetBlock.id]: '5000',
          [qualificationBlock.id]: 'No califico'
        }
      }
    )

    assert.equal(result.status, 'disqualified')
    assert.ok(result.contactId)

    const enrollments = await waitForAutomationEnrollments([contactAutomationId, formAutomationId])
    const byAutomation = new Map(enrollments.map(row => [row.automation_id, row]))
    assert.ok(byAutomation.get(contactAutomationId))
    assert.ok(byAutomation.get(formAutomationId))

    const formContext = JSON.parse(byAutomation.get(formAutomationId).context)
    assert.equal(formContext.formStatus, 'disqualified')
    assert.equal(formContext.formDisqualified, true)
    assert.equal(formContext.formResponses.byKey.presupuesto, '5000')
    assert.equal(formContext.formResponses.byLabel['Presupuesto mensual'], '5000')
    assert.match(formContext.formResponses.summary, /Presupuesto mensual: 5000/)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id IN (?, ?)', [contactAutomationId, formAutomationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id IN (?, ?)', [contactAutomationId, formAutomationId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('site blocks keep the editor provided id when manually saved', async () => {
  const blockId = crypto.randomUUID()
  let site

  try {
    site = await createSite({
      name: 'Sitio guardado manual',
      slug: `manual-save-${Date.now()}`,
      siteType: 'landing_page',
      status: 'draft',
      blankCanvas: true
    })

    const siteWithBlock = await createBlock(site.id, {
      id: blockId,
      blockType: 'text',
      label: 'Texto local',
      content: 'Contenido pendiente',
      settings: { pageId: 'page-1' }
    })

    assert.ok(siteWithBlock.blocks.some(block => block.id === blockId))
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('native form system fields cannot be added twice', async () => {
  let site

  try {
    site = await createSite({
      name: 'Formulario sistema unico',
      slug: `system-unique-${Date.now()}`,
      siteType: 'standard_form',
      status: 'draft',
      blankCanvas: true
    })

    await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Nombre completo',
      settings: { systemFieldKey: 'full_name', internalName: 'full_name' }
    })

    await assert.rejects(
      () => createBlock(site.id, {
        blockType: 'short_text',
        label: 'Nombre completo copia',
        settings: { systemFieldKey: 'full_name', internalName: 'full_name' }
      }),
      error => error?.status === 409 && error?.code === 'duplicate_system_form_field'
    )
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('manual block restore rejects repeated native system fields', async () => {
  let site

  try {
    site = await createSite({
      name: 'Formulario restore unico',
      slug: `restore-system-unique-${Date.now()}`,
      siteType: 'standard_form',
      status: 'draft',
      blankCanvas: true
    })

    await assert.rejects(
      () => restoreBlocks(site.id, [
        {
          id: crypto.randomUUID(),
          blockType: 'email',
          label: 'Correo',
          settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
        },
        {
          id: crypto.randomUUID(),
          blockType: 'email',
          label: 'Correo alterno',
          settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
        }
      ]),
      error => error?.status === 409 && error?.code === 'duplicate_system_form_field'
    )
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('embedded form settings reject repeated system fields', async () => {
  let site

  try {
    site = await createSite({
      name: 'Landing formulario embebido unico',
      slug: `embedded-system-unique-${Date.now()}`,
      siteType: 'landing_page',
      status: 'draft',
      blankCanvas: true
    })

    await assert.rejects(
      () => createBlock(site.id, {
        blockType: 'form_embed',
        label: 'Formulario',
        settings: {
          embeddedBlocks: [
            {
              id: crypto.randomUUID(),
              blockType: 'phone',
              label: 'Telefono',
              settings: { systemFieldKey: 'phone', internalName: 'phone', validation: 'phone' }
            },
            {
              id: crypto.randomUUID(),
              blockType: 'phone',
              label: 'Telefono alterno',
              settings: { systemFieldKey: 'phone', internalName: 'phone', validation: 'phone' }
            }
          ]
        }
      }),
      error => error?.status === 409 && error?.code === 'duplicate_system_form_field'
    )
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})
