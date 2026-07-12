import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import {
  buildCalendarMetaPixelSnippet,
  createBlock,
  createImportedSiteFromHtml,
  createSite,
  createSubmissionFromRequest,
  deleteSite,
  renderPublicSiteHtml
} from '../src/services/sitesService.js'
import { renderPublicCalendarHtml } from '../src/services/localCalendarService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

function publicReq(path = '/') {
  return {
    headers: { host: 'example.test', 'user-agent': 'node-test' },
    hostname: 'example.test',
    path,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  }
}

async function withPublicDomain(fn) {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')
    return await fn()
  } finally {
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain || '')
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified || '')
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt || '')
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error || '')
  }
}

async function withMetaGraphMock(fn) {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousMetaEnv = {
    pixelId: process.env.META_PIXEL_ID,
    datasetId: process.env.META_DATASET_ID,
    accessToken: process.env.META_ACCESS_TOKEN
  }
  const metaCalls = []
  let metaServer

  try {
    await db.run('DELETE FROM meta_config')
    process.env.META_PIXEL_ID = 'pixel-sites-meta-delivery'
    process.env.META_DATASET_ID = ''
    process.env.META_ACCESS_TOKEN = 'token-sites-meta-delivery'
    metaServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        metaCalls.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events_received: 1 }))
      })
    })
    await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    return await fn(metaCalls)
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousMetaEnv.pixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousMetaEnv.pixelId
    if (previousMetaEnv.datasetId === undefined) delete process.env.META_DATASET_ID
    else process.env.META_DATASET_ID = previousMetaEnv.datasetId
    if (previousMetaEnv.accessToken === undefined) delete process.env.META_ACCESS_TOKEN
    else process.env.META_ACCESS_TOKEN = previousMetaEnv.accessToken
    await db.run('DELETE FROM meta_config').catch(() => undefined)
  }
}

async function createLeadForm({ suffix, name = 'Formulario Lead' } = {}) {
  let site = await createSite({
    name: `${name} ${suffix}`,
    slug: `form-lead-${suffix}`,
    siteType: 'standard_form',
    status: 'published',
    blankCanvas: true,
    metaCapiEnabled: true,
    metaEventName: 'Lead',
    theme: {
      template: 'compact',
      metaEventParameters: {
        contentName: 'Lead de formulario',
        status: 'qualified',
        custom: [{ key: 'source_surface', value: 'form' }]
      }
    }
  })
  site = await createBlock(site.id, {
    blockType: 'email',
    label: 'Correo',
    placeholder: 'tu@email.com',
    required: true,
    settings: { pageId: 'page-1', systemFieldKey: 'email', validation: 'email' }
  })
  const emailBlock = site.blocks.find(block => block.blockType === 'email')
  assert.ok(emailBlock, 'lead form should include email field')
  return { site, emailBlock }
}

async function createLandingWithEmbeddedForm(sourceSite, suffix) {
  let landing = await createSite({
    name: `Landing embed ${suffix}`,
    slug: `landing-embed-${suffix}`,
    siteType: 'landing_page',
    status: 'published',
    blankCanvas: true,
    metaCapiEnabled: false,
    metaEventName: 'none',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Landing', sortOrder: 0 }]
    }
  })
  landing = await createBlock(landing.id, {
    blockType: 'form_embed',
    label: 'Formulario embebido',
    settings: {
      pageId: 'page-1',
      formSiteId: sourceSite.id
    }
  })
  return landing
}

test('landing form embeds inherit source form Meta submit config for browser pixel render', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const previousPixelId = process.env.META_PIXEL_ID
  let sourceForm
  let landing

  try {
    process.env.META_PIXEL_ID = 'pixel-render-embed'
    ;({ site: sourceForm } = await createLeadForm({ suffix }))
    landing = await createLandingWithEmbeddedForm(sourceForm, suffix)

    const html = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(html, /connect\.facebook\.net\/en_US\/fbevents\.js/)
    assert.match(html, /ristakMetaTrackSiteSubmit/)
    assert.match(html, /eventName \|\| "Lead"/)
    assert.match(html, /source_surface/)
  } finally {
    if (landing?.id) await deleteSite(landing.id).catch(() => undefined)
    if (sourceForm?.id) await deleteSite(sourceForm.id).catch(() => undefined)
    if (previousPixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousPixelId
  }
})

test('landing form embeds send CAPI with the source form Meta event when landing Meta is off', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `embed-meta-${suffix}@example.test`
  let sourceForm
  let emailBlock
  let landing

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        ;({ site: sourceForm, emailBlock } = await createLeadForm({ suffix }))
        landing = await createLandingWithEmbeddedForm(sourceForm, suffix)

        const result = await createSubmissionFromRequest(
          publicReq(`/${landing.slug}`),
          {
            siteId: landing.id,
            pageId: 'page-1',
            responses: {
              [emailBlock.id]: email
            },
            meta: {
              pageUrl: `https://example.test/${landing.slug}?fbclid=embed-click`,
              eventTime: 1700000010000,
              visitorId: 'visitor-embed-meta',
              fbp: 'fb.1.1700000010.123456789'
            }
          }
        )

        assert.equal(result.capi.sent, true)
        assert.equal(result.capi.eventName, 'Lead')
        assert.equal(metaCalls.length, 1)
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Lead')
        assert.equal(payload.data[0].event_id, result.capi.eventId)
        assert.equal(payload.data[0].custom_data.conversion_type, 'embedded_form_submit')
        assert.equal(payload.data[0].custom_data.form_site_id, sourceForm.id)
        assert.match(payload.data[0].custom_data.form_site_name, /Formulario Lead/)
        assert.equal(payload.data[0].custom_data.content_name, 'Landing embed ' + suffix)
        assert.ok(payload.data[0].user_data.em, 'CAPI should include hashed email')
      } finally {
        if (landing?.id) await deleteSite(landing.id).catch(() => undefined)
        if (sourceForm?.id) await deleteSite(sourceForm.id).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
      }
    })
  })
})

test('standalone forms still send browser-matched CAPI submit events', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `standalone-meta-${suffix}@example.test`
  let sourceForm
  let emailBlock

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        ;({ site: sourceForm, emailBlock } = await createLeadForm({ suffix, name: 'Formulario Standalone Lead' }))

        const result = await createSubmissionFromRequest(
          publicReq(`/${sourceForm.slug}`),
          {
            siteId: sourceForm.id,
            pageId: 'page-1',
            finalSubmit: true,
            responses: {
              [emailBlock.id]: email
            },
            meta: {
              pageUrl: `https://example.test/${sourceForm.slug}?fbclid=standalone-click`,
              eventTime: 1700000020000,
              visitorId: 'visitor-standalone-meta',
              fbp: 'fb.1.1700000020.987654321'
            }
          }
        )

        assert.equal(result.capi.sent, true)
        assert.equal(result.capi.eventName, 'Lead')
        assert.equal(metaCalls.length, 1)
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Lead')
        assert.equal(payload.data[0].event_id, result.capi.eventId)
        assert.equal(payload.data[0].custom_data.conversion_type, 'form_submit')
        assert.match(payload.data[0].custom_data.content_name, /^Formulario Standalone Lead/)
        assert.ok(payload.data[0].user_data.em, 'CAPI should include hashed email')
      } finally {
        if (sourceForm?.id) await deleteSite(sourceForm.id).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
      }
    })
  })
})

test('imported HTML forms can declare Schedule conversion metadata for Meta CAPI', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-schedule-${suffix}@example.test`
  const previousCurrency = await getAppConfig('account_currency')
  let siteId = ''
  let sourceFormId = ''

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        await setAppConfig('account_currency', 'USD')
        const html = `
          <!doctype html>
          <html>
            <head><title>Agenda importada</title></head>
            <body>
              <form
                id="agenda"
                data-rstk-form-id="agenda"
                data-rstk-conversion-event="Schedule"
                data-rstk-conversion-type="appointment_scheduled"
                data-rstk-calendar-name="Consulta inicial">
                <input id="email" name="email" type="email" data-rstk-field="email">
                <input type="hidden" data-rstk-conversion-param="appointment_start_time" value="2026-08-15T17:00:00Z">
                <button type="submit">Agendar</button>
              </form>
            </body>
          </html>
        `
        const created = await createImportedSiteFromHtml({
          filename: 'agenda-importada.html',
          fileBase64: Buffer.from(html, 'utf8').toString('base64'),
          siteType: 'landing_page',
          name: `Agenda Importada ${suffix}`
        })
        siteId = created.site.id
        sourceFormId = created.import.formMappings[0]?.formSiteId || ''
        await db.run(
          "UPDATE public_sites SET status = 'published', meta_capi_enabled = 1, meta_event_name = 'Lead' WHERE id = ?",
          [siteId]
        )

        const result = await createSubmissionFromRequest(
          publicReq(`/${created.site.slug}`),
          {
            siteId,
            importedFormId: created.import.formMappings[0].formId,
            rawFields: { email },
            meta: {
              pageUrl: `https://example.test/${created.site.slug}?fbclid=imported-schedule`,
              eventTime: 1700000040000,
              visitorId: 'visitor-imported-schedule',
              fbp: 'fb.1.1700000040.1122334455',
              importedConversion: {
                eventName: 'Schedule',
                conversionType: 'appointment_scheduled',
                calendarName: 'Consulta inicial',
                appointmentStartTime: '2026-08-15T17:00:00Z',
                appointmentEndTime: '2026-08-15T17:30:00Z',
                value: '500',
                custom: [{ key: 'source_surface', value: 'html_imported' }]
              }
            }
          }
        )

        assert.equal(result.capi.sent, true)
        assert.equal(result.capi.eventName, 'Schedule')
        assert.equal(metaCalls.length, 1)
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Schedule')
        assert.equal(payload.data[0].event_id, result.capi.eventId)
        assert.equal(payload.data[0].custom_data.source, 'ristak_imported_html')
        assert.equal(payload.data[0].custom_data.conversion_type, 'appointment_scheduled')
        assert.equal(payload.data[0].custom_data.calendar_name, 'Consulta inicial')
        assert.equal(payload.data[0].custom_data.appointment_start_time, '2026-08-15T17:00:00Z')
        assert.equal(payload.data[0].custom_data.appointment_end_time, '2026-08-15T17:30:00Z')
        assert.equal(payload.data[0].custom_data.value, 500)
        assert.equal(payload.data[0].custom_data.currency, 'USD')
        assert.equal(payload.data[0].custom_data.source_surface, 'html_imported')
        assert.equal(result.capi.customData.currency, 'USD')
        const session = await db.get(
          "SELECT tracking_source, conversion_type FROM sessions WHERE submission_id = ? AND event_name = 'native_site_conversion' LIMIT 1",
          [result.submissionId]
        )
        assert.equal(session?.tracking_source, 'native_site')
        assert.equal(session?.conversion_type, 'appointment_scheduled')
      } finally {
        if (siteId) await deleteSite(siteId).catch(() => undefined)
        if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
        await db.run('DELETE FROM sessions WHERE visitor_id = ?', ['visitor-imported-schedule']).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
        await setAppConfig('account_currency', previousCurrency || '')
      }
    })
  })
})

test('imported HTML forms can declare Purchase conversion metadata with account currency', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-purchase-${suffix}@example.test`
  const previousCurrency = await getAppConfig('account_currency')
  let siteId = ''
  let sourceFormId = ''

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        await setAppConfig('account_currency', 'EUR')
        const html = `
          <!doctype html>
          <html>
            <head><title>Checkout importado</title></head>
            <body>
              <form
                id="checkout"
                data-rstk-form-id="checkout"
                data-rstk-conversion-event="Purchase"
                data-rstk-conversion-type="purchase"
                data-rstk-conversion-value="1499.50"
                data-rstk-conversion-content-name="Consulta premium"
                data-rstk-conversion-order-id="ORD-HTML-1">
                <input id="email" name="email" type="email" data-rstk-field="email">
                <button type="submit">Confirmar pago</button>
              </form>
            </body>
          </html>
        `
        const created = await createImportedSiteFromHtml({
          filename: 'checkout-importado.html',
          fileBase64: Buffer.from(html, 'utf8').toString('base64'),
          siteType: 'landing_page',
          name: `Checkout Importado ${suffix}`
        })
        siteId = created.site.id
        sourceFormId = created.import.formMappings[0]?.formSiteId || ''
        await db.run(
          "UPDATE public_sites SET status = 'published', meta_capi_enabled = 1, meta_event_name = 'Lead' WHERE id = ?",
          [siteId]
        )

        const result = await createSubmissionFromRequest(
          publicReq(`/${created.site.slug}`),
          {
            siteId,
            importedFormId: created.import.formMappings[0].formId,
            rawFields: { email },
            meta: {
              pageUrl: `https://example.test/${created.site.slug}?fbclid=imported-purchase`,
              eventTime: 1700000050000,
              visitorId: 'visitor-imported-purchase',
              fbp: 'fb.1.1700000050.9988776655',
              importedConversion: {
                eventName: 'Purchase',
                conversionType: 'purchase',
                value: '1499.50',
                contentName: 'Consulta premium',
                orderId: 'ORD-HTML-1',
                paymentId: 'pay_html_1',
                paymentStatus: 'paid'
              }
            }
          }
        )

        assert.equal(result.capi.sent, true)
        assert.equal(result.capi.eventName, 'Purchase')
        assert.equal(metaCalls.length, 1)
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].event_id, result.capi.eventId)
        assert.equal(payload.data[0].custom_data.source, 'ristak_imported_html')
        assert.equal(payload.data[0].custom_data.conversion_type, 'purchase')
        assert.equal(payload.data[0].custom_data.value, 1499.5)
        assert.equal(payload.data[0].custom_data.currency, 'EUR')
        assert.equal(payload.data[0].custom_data.content_name, 'Consulta premium')
        assert.equal(payload.data[0].custom_data.order_id, 'ORD-HTML-1')
        assert.equal(payload.data[0].custom_data.payment_id, 'pay_html_1')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.equal(result.capi.customData.currency, 'EUR')
        const session = await db.get(
          "SELECT tracking_source, conversion_type FROM sessions WHERE submission_id = ? AND event_name = 'native_site_conversion' LIMIT 1",
          [result.submissionId]
        )
        assert.equal(session?.tracking_source, 'native_site')
        assert.equal(session?.conversion_type, 'purchase')
      } finally {
        if (siteId) await deleteSite(siteId).catch(() => undefined)
        if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
        await db.run('DELETE FROM sessions WHERE visitor_id = ?', ['visitor-imported-purchase']).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
        await setAppConfig('account_currency', previousCurrency || '')
      }
    })
  })
})

test('imported HTML qualification rules keep the submit but suppress Pixel/CAPI for disqualified contacts', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `html-qualified-only-${suffix}@example.test`
  let siteId = ''
  let sourceFormId = ''

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        const html = `
          <!doctype html>
          <html>
            <head><title>Filtro importado</title></head>
            <body>
              <form
                id="filtro"
                data-rstk-form-id="filtro"
                data-rstk-conversion-event="Lead"
                data-rstk-conversion-type="form_submit"
                data-rstk-conversion-condition="qualified_only">
                <input id="email" name="email" type="email" data-rstk-field="email">
                <label>
                  <input
                    type="radio"
                    name="candidato"
                    value="no"
                    data-rstk-choice-actions='[{"id":"no-califica","action":"disqualify","disqualifyOutcome":"url","buttonUrl":"https://example.test/no-califica"}]'>
                  No califico
                </label>
                <button type="submit">Enviar</button>
              </form>
            </body>
          </html>
        `
        const created = await createImportedSiteFromHtml({
          filename: 'filtro-importado.html',
          fileBase64: Buffer.from(html, 'utf8').toString('base64'),
          siteType: 'landing_page',
          name: `Filtro Importado ${suffix}`
        })
        siteId = created.site.id
        sourceFormId = created.import.formMappings[0]?.formSiteId || ''
        await db.run(
          "UPDATE public_sites SET status = 'published', meta_capi_enabled = 1, meta_event_name = 'Lead' WHERE id = ?",
          [siteId]
        )

        const rendered = await renderPublicSiteHtml({
          ...created.site,
          status: 'published',
          metaCapiEnabled: true,
          metaEventName: 'Lead'
        }, {
          pageId: 'page-1',
          trackingEnabled: true,
          preview: false
        })
        assert.match(rendered, /data-rstk-conversion-condition="qualified_only"/)
        assert.match(rendered, /setIfValue\(data, 'submitCondition'/)
        assert.match(rendered, /submit_condition: importedConversion && importedConversion\.submitCondition/)
        assert.match(rendered, /action === 'disqualify' && action\.buttonUrl/)

        const result = await createSubmissionFromRequest(
          publicReq(`/${created.site.slug}`),
          {
            siteId,
            importedFormId: created.import.formMappings[0].formId,
            rawFields: { email, candidato: 'no' },
            meta: {
              pageUrl: `https://example.test/${created.site.slug}?fbclid=qualified-only`,
              eventTime: 1700000060000,
              visitorId: 'visitor-imported-qualified-only',
              fbp: 'fb.1.1700000060.123123123',
              importedDisqualified: true,
              importedDisqualifiedMessage: 'Gracias. Por ahora no calificas.',
              importedChoiceActions: [{
                action: 'disqualify',
                disqualifyOutcome: 'url',
                buttonUrl: 'https://example.test/no-califica'
              }],
              importedConversion: {
                eventName: 'Lead',
                conversionType: 'form_submit',
                submitCondition: 'qualified_only'
              }
            }
          }
        )

        assert.equal(result.status, 'disqualified')
        assert.ok(result.submissionId)
        assert.equal(result.capi.sent, false)
        assert.equal(result.capi.reason, 'qualified_only_disqualified')
        assert.equal(metaCalls.length, 0)
        const stored = await db.get('SELECT status, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
        assert.equal(stored.status, 'disqualified')
        assert.equal(JSON.parse(stored.meta_json).formDisqualified, true)
      } finally {
        if (siteId) await deleteSite(siteId).catch(() => undefined)
        if (sourceFormId) await deleteSite(sourceFormId).catch(() => undefined)
        await db.run('DELETE FROM sessions WHERE visitor_id = ?', ['visitor-imported-qualified-only']).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
      }
    })
  })
})

test('standalone forms can map option response value and text into CAPI parameters', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const email = `option-meta-${suffix}@example.test`
  let sourceForm
  let emailBlock
  let budgetBlock

  await withPublicDomain(async () => {
    await withMetaGraphMock(async metaCalls => {
      try {
        ;({ site: sourceForm, emailBlock } = await createLeadForm({ suffix, name: 'Formulario Valor Meta' }))
        sourceForm = {
          ...sourceForm,
          theme: {
            ...(sourceForm.theme || {}),
            metaEventParameters: {
              ...(sourceForm.theme?.metaEventParameters || {}),
              value: '{{form.responses.presupuesto.value}}',
              custom: [
                ...(sourceForm.theme?.metaEventParameters?.custom || []),
                { key: 'budget_text', value: '{{form.responses.presupuesto.text}}' }
              ]
            }
          }
        }
        await db.run('UPDATE public_sites SET theme_json = ? WHERE id = ?', [JSON.stringify(sourceForm.theme), sourceForm.id])
        sourceForm = await createBlock(sourceForm.id, {
          blockType: 'radio',
          label: 'Presupuesto mensual',
          required: true,
          options: [
            { label: '3,500 a 5,000 pesos', value: '3500' },
            { label: '5,000 pesos o más', value: '5000' }
          ],
          settings: { pageId: 'page-1', customFieldKey: 'presupuesto' }
        })
        budgetBlock = sourceForm.blocks.find(block => block.blockType === 'radio')
        assert.ok(budgetBlock, 'lead form should include budget field')

        const result = await createSubmissionFromRequest(
          publicReq(`/${sourceForm.slug}`),
          {
            siteId: sourceForm.id,
            pageId: 'page-1',
            finalSubmit: true,
            responses: {
              [emailBlock.id]: email,
              [budgetBlock.id]: '3500'
            },
            meta: {
              pageUrl: `https://example.test/${sourceForm.slug}?fbclid=option-click`,
              eventTime: 1700000030000,
              visitorId: 'visitor-option-meta',
              fbp: 'fb.1.1700000030.246813579'
            }
          }
        )

        assert.equal(result.capi.sent, true)
        assert.equal(metaCalls.length, 1)
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].custom_data.value, 3500)
        assert.equal(payload.data[0].custom_data.budget_text, '3,500 a 5,000 pesos')
      } finally {
        if (sourceForm?.id) await deleteSite(sourceForm.id).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
      }
    })
  })
})

test('public calendars render browser pixel helper for site and smart Meta events', async () => {
  const previousPixelId = process.env.META_PIXEL_ID
  try {
    await db.run('DELETE FROM meta_config')
    process.env.META_PIXEL_ID = 'pixel-calendar-browser'
    const calendar = {
      id: 'calendar-meta-browser',
      slug: 'agenda-meta-browser',
      name: 'Agenda Meta Browser',
      eventTitle: 'Cita demo',
      slotDuration: 30,
      customEvents: {
        enabled: true,
        channel: 'smart',
        eventName: 'Schedule',
        parameters: {
          value: '500',
          currency: 'mxn'
        }
      }
    }

    const snippet = await buildCalendarMetaPixelSnippet(calendar, {
      trackingEnabled: true,
      preview: false
    })
    const html = renderPublicCalendarHtml(calendar, {
      embedded: false,
      metaPixelSnippet: snippet
    })

    assert.match(html, /connect\.facebook\.net\/en_US\/fbevents\.js/)
    assert.match(html, /window\.ristakMetaTrackCalendarEvent/)
    assert.match(html, /window\.ristakMetaTrackCalendarEvent\(metaEvent\.eventName, metaEvent\.eventId/)
    assert.match(html, /"Schedule"/)
  } finally {
    if (previousPixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousPixelId
    await db.run('DELETE FROM meta_config').catch(() => undefined)
  }
})
