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

test('landing funnel form submission ignores payment blocks from later pages and creates the contact', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = crypto.randomUUID()
  const email = `landing-funnel-${suffix}@example.test`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Funnel formulario calendario pago',
      slug: `funnel-form-pay-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        pages: [
          { id: 'page-1', title: 'Formulario', sortOrder: 0 },
          { id: 'page-2', title: 'Calendario', sortOrder: 1 },
          { id: 'page-3', title: 'Pago', sortOrder: 2 }
        ]
      }
    })

    const siteWithName = await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Nombre completo',
      required: true,
      settings: { pageId: 'page-1', systemFieldKey: 'full_name', internalName: 'full_name' }
    })
    const nameBlock = siteWithName.blocks.find(block => block.label === 'Nombre completo')

    const siteWithEmail = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      required: true,
      settings: { pageId: 'page-1', systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    const emailBlock = siteWithEmail.blocks.find(block => block.label === 'Correo electronico')

    await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Agenda',
      settings: { pageId: 'page-2', calendarId: 'calendar-test', calendarSlug: 'calendar-test' }
    })
    await createBlock(site.id, {
      blockType: 'payment',
      label: 'Pago',
      settings: {
        pageId: 'page-3',
        paymentGate: {
          enabled: true,
          gateway: 'stripe',
          amount: 1200,
          currency: 'MXN',
          productName: 'Programa',
          buttonText: 'Pagar'
        }
      }
    })

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
        pageId: 'page-1',
        responses: {
          [nameBlock.id]: 'Raul Gomez',
          [emailBlock.id]: email
        }
      }
    )

    assert.notEqual(result.status, 'payment_pending')
    assert.equal(result.paymentRequired, undefined)
    assert.ok(result.contactId)
    assert.ok(result.submissionId)

    const contact = await db.get('SELECT email, full_name, source FROM contacts WHERE id = ?', [result.contactId])
    assert.equal(contact.email, email)
    assert.equal(contact.full_name, 'Raul Gomez')
    assert.equal(contact.source, `ristak_site:${site.slug}`)

    const submission = await db.get('SELECT contact_id, status FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.contact_id, result.contactId)
    assert.equal(submission.status, 'received')
  } finally {
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
    assert.match(html, /data-field-error aria-live="polite"/)
    assert.match(html, /Te falta completar: /)
    assert.match(html, /Selecciona una opción en: /)
    assert.match(html, /data-invalid/)
    assert.match(html, /aria-invalid/)
    assert.match(html, /validateFields\(fieldsToValidate\)/)
  } finally {
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
  }
})

test('native form system email and phone validate automatically without manual validation setting', async () => {
  const site = {
    id: 'site_auto_system_validation',
    name: 'Formulario validacion sistema',
    title: 'Formulario validacion sistema',
    description: '',
    slug: 'form-auto-system-validation',
    siteType: 'standard_form',
    status: 'published',
    theme: { template: 'ristak' },
    blocks: [
      {
        id: 'legacy-system-email',
        siteId: 'site_auto_system_validation',
        blockType: 'short_text',
        label: 'Correo',
        content: '',
        placeholder: 'correo@ejemplo.com',
        required: true,
        options: [],
        sortOrder: 0,
        settings: { systemFieldKey: 'email', internalName: 'email' },
        createdAt: '',
        updatedAt: ''
      },
      {
        id: 'legacy-system-phone',
        siteId: 'site_auto_system_validation',
        blockType: 'short_text',
        label: 'Telefono',
        content: '',
        placeholder: '10 digitos',
        required: true,
        options: [],
        sortOrder: 1,
        settings: { systemFieldKey: 'phone', internalName: 'phone' },
        createdAt: '',
        updatedAt: ''
      },
      {
        id: 'manual-url',
        siteId: 'site_auto_system_validation',
        blockType: 'short_text',
        label: 'Sitio',
        content: '',
        placeholder: 'https://ejemplo.com',
        required: false,
        options: [],
        sortOrder: 2,
        settings: { internalName: 'website', validation: 'url' },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, { preview: true })

  assert.match(html, /data-system-field-key="email"[^>]*data-validation="email"/)
  assert.match(html, /data-system-field-key="phone"[^>]*data-validation="phone"/)
  assert.match(html, /data-system-field-key=""[^>]*data-validation="url"/)
  assert.match(html, /id="legacy-system-email" name="legacy-system-email" type="email"/)
  assert.match(html, /id="legacy-system-phone" name="legacy-system-phone" type="tel"/)
  assert.match(html, /const isValidEmailValue/)
  assert.match(html, /const isLikelyPhoneValue/)
  assert.match(html, /digits\.startsWith\('52'\)/)
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

test('native form option rules redirect to site pages, external URLs and disqualified destinations', async () => {
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

    let siteWithFields = await createBlock(site.id, {
      blockType: 'short_text',
      label: 'Pregunta de seguimiento',
      required: false,
      settings: { pageId: 'page-2' }
    })
    const followUpField = siteWithFields.blocks.find(block => block.label === 'Pregunta de seguimiento')
    assert.ok(followUpField)

    siteWithFields = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Destino',
      required: false,
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
          message: 'No califica por ahora.',
          redirectUrl: 'https://example.com/no-califica'
        },
        {
          id: 'not-qualified-message',
          label: 'No califico mensaje',
          value: 'No califico mensaje',
          action: 'disqualify_after_submit',
          message: 'No califica, mostrar mensaje.'
        },
        {
          id: 'not-qualified-page',
          label: 'No califico pagina',
          value: 'No califico pagina',
          action: 'disqualify_after_submit',
          message: 'No califica, ir a pagina.',
          targetPageId: 'page-2'
        },
        {
          id: 'not-qualified-question',
          label: 'No califico pregunta',
          value: 'No califico pregunta',
          action: 'disqualify_after_submit',
          message: 'No califica, ir a pregunta.',
          targetBlockId: followUpField.id
        },
        {
          id: 'immediate-message',
          label: 'Inmediato mensaje',
          value: 'Inmediato mensaje',
          action: 'disqualify',
          message: 'Descalificado inmediato.'
        },
        {
          id: 'immediate-url',
          label: 'Inmediato URL',
          value: 'Inmediato URL',
          action: 'disqualify',
          message: 'Descalificado inmediato con URL.',
          redirectUrl: 'https://example.com/inmediato'
        }
      ]
    })
    siteWithFields = await createBlock(site.id, {
      blockType: 'dropdown',
      label: 'Segmento',
      required: false,
      settings: { pageId: 'page-1' },
      options: [
        {
          id: 'qualified-dropdown',
          label: 'Califica',
          value: 'Califica',
          action: 'continue'
        },
        {
          id: 'not-qualified-dropdown',
          label: 'No apto',
          value: 'No apto',
          action: 'disqualify_after_submit',
          message: 'Ruta no apta.',
          redirectUrl: 'https://example.com/lista-espera'
        }
      ]
    })

    const field = siteWithFields.blocks.find(block => block.blockType === 'radio')
    const dropdownField = siteWithFields.blocks.find(block => block.blockType === 'dropdown')
    assert.ok(field)
    assert.ok(dropdownField)

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
    assert.equal(externalResult.rules.actions[0].submitBeforeAction, true)

    const disqualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'No califico'
      }
    })

    assert.equal(disqualifiedResult.status, 'disqualified')
    assert.equal(disqualifiedResult.message, 'No califica por ahora.')
    assert.equal(disqualifiedResult.redirectUrl, 'https://example.com/no-califica')
    assert.equal(disqualifiedResult.rules.actions[0].action, 'disqualify_after_submit')

    const disqualifiedMessageResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'No califico mensaje'
      }
    })

    assert.equal(disqualifiedMessageResult.status, 'disqualified')
    assert.equal(disqualifiedMessageResult.message, 'No califica, mostrar mensaje.')
    assert.equal(disqualifiedMessageResult.redirectUrl, '')
    assert.equal(disqualifiedMessageResult.rules.actions[0].action, 'disqualify_after_submit')

    const disqualifiedPageResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'No califico pagina'
      }
    })

    assert.equal(disqualifiedPageResult.status, 'disqualified')
    assert.equal(disqualifiedPageResult.message, 'No califica, ir a pagina.')
    assert.equal(disqualifiedPageResult.redirectUrl, '?page=page-2')
    assert.equal(disqualifiedPageResult.rules.targetPageId, 'page-2')

    const disqualifiedQuestionResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [field.id]: 'No califico pregunta'
      }
    })

    assert.equal(disqualifiedQuestionResult.status, 'disqualified')
    assert.equal(disqualifiedQuestionResult.message, 'No califica, ir a pregunta.')
    assert.equal(disqualifiedQuestionResult.redirectUrl, '?page=page-2')
    assert.equal(disqualifiedQuestionResult.rules.targetBlockId, followUpField.id)
    assert.equal(disqualifiedQuestionResult.rules.targetPageId, 'page-2')

    const immediateMessageResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      meta: { ruleAction: 'disqualify', immediateDisqualify: true },
      responses: {
        [field.id]: 'Inmediato mensaje'
      }
    })

    assert.equal(immediateMessageResult.status, 'disqualified')
    assert.equal(immediateMessageResult.message, 'Descalificado inmediato.')
    assert.equal(immediateMessageResult.redirectUrl, '')

    const immediateUrlResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      meta: { ruleAction: 'disqualify', immediateDisqualify: true },
      responses: {
        [field.id]: 'Inmediato URL'
      }
    })

    assert.equal(immediateUrlResult.status, 'disqualified')
    assert.equal(immediateUrlResult.message, 'Descalificado inmediato con URL.')
    assert.equal(immediateUrlResult.redirectUrl, 'https://example.com/inmediato')

    const dropdownDisqualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      pageId: 'page-1',
      responses: {
        [dropdownField.id]: 'No apto'
      }
    })

    assert.equal(dropdownDisqualifiedResult.status, 'disqualified')
    assert.equal(dropdownDisqualifiedResult.message, 'Ruta no apta.')
    assert.equal(dropdownDisqualifiedResult.redirectUrl, 'https://example.com/lista-espera')
    assert.equal(dropdownDisqualifiedResult.rules.actions[0].action, 'disqualify_after_submit')
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

test('standard form qualification flow redirects to the automatic result pages', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = crypto.randomUUID()
  const emails = {
    qualified: `qualified-${suffix}@example.test`,
    disqualified: `disqualified-${suffix}@example.test`,
    immediate: `immediate-${suffix}@example.test`
  }
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario resultados automaticos',
      slug: `form-results-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        formCompletionAction: 'redirect_qualified',
        formQualifiedRedirectUrl: 'https://example.com/legacy-gracias',
        formDisqualifiedCompletionAction: 'redirect_url',
        formDisqualifiedRedirectUrl: 'https://example.com/legacy-no-califica'
      }
    })

    let siteWithBlocks = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    siteWithBlocks = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Calificacion',
      required: true,
      settings: { internalName: 'calificacion' },
      options: [
        {
          id: 'qualified',
          label: 'Si califico',
          value: 'Si califico',
          action: 'continue'
        },
        {
          id: 'not-qualified-submit',
          label: 'No califico al enviar',
          value: 'No califico al enviar',
          action: 'disqualify_after_submit',
          message: 'No califica al enviar.'
        },
        {
          id: 'not-qualified-immediate',
          label: 'No califico inmediato',
          value: 'No califico inmediato',
          action: 'disqualify',
          message: 'No califica inmediato.'
        }
      ]
    })

    const emailBlock = siteWithBlocks.blocks.find(block => block.blockType === 'email')
    const qualificationBlock = siteWithBlocks.blocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(qualificationBlock)

    const baseReq = {
      headers: { host: 'example.test', 'user-agent': 'node-test' },
      hostname: 'example.test',
      path: `/${site.slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }

    const qualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      finalSubmit: true,
      responses: {
        [emailBlock.id]: emails.qualified,
        [qualificationBlock.id]: 'Si califico'
      }
    })

    assert.equal(qualifiedResult.status, 'received')
    assert.equal(qualifiedResult.redirectUrl, '?page=page-2')

    const submitDisqualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      finalSubmit: true,
      responses: {
        [emailBlock.id]: emails.disqualified,
        [qualificationBlock.id]: 'No califico al enviar'
      }
    })

    assert.equal(submitDisqualifiedResult.status, 'disqualified')
    assert.equal(submitDisqualifiedResult.message, 'No califica al enviar.')
    assert.equal(submitDisqualifiedResult.redirectUrl, '?page=page-3')

    const immediateDisqualifiedResult = await createSubmissionFromRequest(baseReq, {
      siteId: site.id,
      meta: { ruleAction: 'disqualify', immediateDisqualify: true },
      responses: {
        [emailBlock.id]: emails.immediate,
        [qualificationBlock.id]: 'No califico inmediato'
      }
    })

    assert.equal(immediateDisqualifiedResult.status, 'disqualified')
    assert.equal(immediateDisqualifiedResult.message, 'No califica inmediato.')
    assert.equal(immediateDisqualifiedResult.redirectUrl, '?page=page-3')
  } finally {
    await db.run(
      `DELETE FROM contacts WHERE email IN (?, ?, ?)`,
      [emails.qualified, emails.disqualified, emails.immediate]
    ).catch(() => undefined)
    if (site?.id) {
      await deleteSite(site.id).catch(() => undefined)
    }
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('standard form rule redirects save reached multipage answers before leaving', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = crypto.randomUUID()
  const email = `multipage-redirect-${suffix}@example.test`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario multipagina con salida',
      slug: `form-multipage-exit-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        submitIncompleteOnExit: true,
        pages: [
          { id: 'page-1', title: 'Datos', sortOrder: 0 },
          { id: 'page-4', title: 'Filtro', sortOrder: 1 },
          { id: 'page-2', title: 'Agradecimiento', sortOrder: 2 },
          { id: 'page-3', title: 'Descalificacion', sortOrder: 3 }
        ]
      }
    })

    let siteWithBlocks = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      required: true,
      settings: { pageId: 'page-1', systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    siteWithBlocks = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Ruta',
      required: true,
      settings: { pageId: 'page-4', internalName: 'ruta' },
      options: [
        {
          id: 'external',
          label: 'Ir a oferta',
          value: 'Ir a oferta',
          action: 'redirect',
          redirectUrl: 'https://example.com/oferta-externa',
          submitBeforeAction: false
        }
      ]
    })

    const emailBlock = siteWithBlocks.blocks.find(block => block.blockType === 'email')
    const routeBlock = siteWithBlocks.blocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(routeBlock)

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
        pageId: 'page-4',
        meta: { ruleSubmit: true, ruleAction: 'redirect' },
        responses: {
          [emailBlock.id]: email,
          [routeBlock.id]: 'Ir a oferta'
        }
      }
    )

    assert.equal(result.status, 'received')
    assert.equal(result.redirectUrl, 'https://example.com/oferta-externa')
    assert.equal(result.rules.actions[0].submitBeforeAction, true)
    assert.equal(result.mappedFields.standard.email, email)

    const stored = await db.get('SELECT response_json, status FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(stored.status, 'received')
    const savedResponses = JSON.parse(stored.response_json)
    assert.equal(savedResponses[emailBlock.id], email)
    assert.equal(savedResponses[routeBlock.id], 'Ir a oferta')
  } finally {
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

test('standard form skips incomplete rule submissions by default', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = crypto.randomUUID()
  const email = `multipage-skip-${suffix}@example.test`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario multipagina sin guardado temprano',
      slug: `form-multipage-skip-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        pages: [
          { id: 'page-1', title: 'Datos', sortOrder: 0 },
          { id: 'page-4', title: 'Filtro', sortOrder: 1 },
          { id: 'page-2', title: 'Agradecimiento', sortOrder: 2 },
          { id: 'page-3', title: 'Descalificacion', sortOrder: 3 }
        ]
      }
    })

    let siteWithBlocks = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo electronico',
      required: true,
      settings: { pageId: 'page-1', systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    siteWithBlocks = await createBlock(site.id, {
      blockType: 'radio',
      label: 'Ruta',
      required: true,
      settings: { pageId: 'page-4', internalName: 'ruta' },
      options: [
        {
          id: 'external',
          label: 'Ir a oferta',
          value: 'Ir a oferta',
          action: 'redirect',
          redirectUrl: 'https://example.com/oferta-sin-guardar'
        },
        {
          id: 'disqualified',
          label: 'No califica',
          value: 'No califica',
          action: 'disqualify',
          message: 'No califica por ahora.'
        }
      ]
    })

    const emailBlock = siteWithBlocks.blocks.find(block => block.blockType === 'email')
    const routeBlock = siteWithBlocks.blocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(routeBlock)

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
        pageId: 'page-4',
        meta: { ruleSubmit: true, ruleAction: 'redirect' },
        responses: {
          [emailBlock.id]: email,
          [routeBlock.id]: 'Ir a oferta'
        }
      }
    )

    assert.equal(result.skipped, true)
    assert.equal(result.submissionId, '')
    assert.equal(result.contactId, null)
    assert.equal(result.redirectUrl, 'https://example.com/oferta-sin-guardar')

    const disqualifiedResult = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        pageId: 'page-4',
        meta: { ruleSubmit: true, ruleAction: 'disqualify', immediateDisqualify: true },
        responses: {
          [emailBlock.id]: email,
          [routeBlock.id]: 'No califica'
        }
      }
    )

    assert.equal(disqualifiedResult.skipped, true)
    assert.equal(disqualifiedResult.status, 'disqualified')
    assert.equal(disqualifiedResult.submissionId, '')
    assert.equal(disqualifiedResult.contactId, null)
    assert.equal(disqualifiedResult.redirectUrl, '?page=page-3')

    const submissionCount = await db.get('SELECT COUNT(*) as total FROM public_site_submissions WHERE site_id = ?', [site.id])
    assert.equal(submissionCount.total, 0)
    const contactCount = await db.get('SELECT COUNT(*) as total FROM contacts WHERE email = ?', [email])
    assert.equal(contactCount.total, 0)
  } finally {
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
