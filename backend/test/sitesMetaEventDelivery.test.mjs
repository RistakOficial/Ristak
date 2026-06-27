import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import {
  buildCalendarMetaPixelSnippet,
  createBlock,
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
