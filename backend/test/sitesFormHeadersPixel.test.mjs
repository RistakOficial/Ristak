import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'

import { db } from '../src/config/database.js'
import { createVariableField } from '../src/services/variableFieldsService.js'
import { requestHasNoTrack } from '../src/utils/noTracking.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteAssetResponse,
  renderPublicSiteHtml,
  resolvePublicSitePersonalizationContactId,
  siteUsesContactTemplateVariables,
  updateSite
} from '../src/services/sitesService.js'

const makeStandardFormSite = () => ({
  id: 'site_form_headers_pixel',
  name: 'Formulario con headers y pixel',
  title: 'Formulario con headers y pixel',
  description: '',
  slug: 'form-headers-pixel',
  siteType: 'standard_form',
  status: 'published',
  metaCapiEnabled: true,
  metaEventName: 'Lead',
  theme: {
    template: 'compact',
    headerTrackingCode: '<script>window.__rstkGlobalHeader = true;</script>',
    pages: [
      {
        id: 'page-1',
        title: 'Formulario',
        sortOrder: 0,
        headerTrackingCode: '<script>window.__rstkFormHeader = true;</script>',
        metaCapiEnabled: true,
        metaEventName: 'ViewContent',
        metaTrigger: 'page_view',
        metaEventParameters: {
          contentName: 'Formulario principal',
          contentCategory: 'Lead form'
        }
      },
      {
        id: 'page-2',
        title: 'Agradecimiento',
        sortOrder: 1,
        headerTrackingCode: '<script>window.__rstkQualifiedHeader = true;</script>',
        metaCapiEnabled: true,
        metaEventName: 'CompleteRegistration',
        metaTrigger: 'page_view',
        metaEventParameters: {
          contentName: 'Lead calificado',
          status: 'qualified'
        }
      },
      {
        id: 'page-3',
        title: 'Descalificacion',
        sortOrder: 2,
        headerTrackingCode: '<script>window.__rstkDisqualifiedHeader = true;</script>',
        metaCapiEnabled: true,
        metaEventName: 'Contact',
        metaTrigger: 'page_view',
        metaEventParameters: {
          contentName: 'Lead descalificado',
          status: 'disqualified'
        }
      }
    ]
  },
  blocks: [
    {
      id: 'field-email',
      siteId: 'site_form_headers_pixel',
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'tu@email.com',
      required: true,
      options: [],
      sortOrder: 0,
      settings: { pageId: 'page-1' },
      createdAt: '',
      updatedAt: ''
    }
  ]
})

async function zipData(files = {}) {
  const zip = new JSZip()
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content)
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64')
}

async function deleteVariableFields(fields = []) {
  for (const field of fields) {
    if (field?.id) {
      await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
    }
  }
}

test('standard form public pages render global/page headers and page Meta Pixel events', async () => {
  const previousPixelId = process.env.META_PIXEL_ID
  process.env.META_PIXEL_ID = '1234567890'

  try {
    const site = makeStandardFormSite()
    const cases = [
      {
        pageId: 'page-1',
        pageHeader: '__rstkFormHeader',
        absentHeaders: ['__rstkQualifiedHeader', '__rstkDisqualifiedHeader'],
        eventName: 'ViewContent',
        pageTitle: 'Formulario',
        parameter: 'Formulario principal'
      },
      {
        pageId: 'page-2',
        pageHeader: '__rstkQualifiedHeader',
        absentHeaders: ['__rstkFormHeader', '__rstkDisqualifiedHeader'],
        eventName: 'CompleteRegistration',
        pageTitle: 'Agradecimiento',
        parameter: 'qualified'
      },
      {
        pageId: 'page-3',
        pageHeader: '__rstkDisqualifiedHeader',
        absentHeaders: ['__rstkFormHeader', '__rstkQualifiedHeader'],
        eventName: 'Contact',
        pageTitle: 'Descalificacion',
        parameter: 'disqualified'
      }
    ]

    for (const item of cases) {
      const html = await renderPublicSiteHtml(site, {
        pageId: item.pageId,
        trackingEnabled: true,
        preview: false
      })

      assert.match(html, /__rstkGlobalHeader/)
      assert.match(html, new RegExp(item.pageHeader))
      for (const absentHeader of item.absentHeaders) {
        assert.doesNotMatch(html, new RegExp(absentHeader))
      }

      assert.match(html, /connect\.facebook\.net\/en_US\/fbevents\.js/)
      assert.match(html, new RegExp(`window\\.ristakMetaTrackSiteEvent\\("${item.eventName}"`))
      assert.match(html, new RegExp(`public_page_id: "${item.pageId}"`))
      assert.match(html, new RegExp(`public_page_title: "${item.pageTitle}"`))
      assert.match(html, new RegExp(item.parameter))
      assert.match(html, /fetch\('\/api\/sites\/public\/meta-event'/)
      assert.match(html, /ristakMetaBuildMetaPayload/)
      assert.match(html, /eventTime: Date\.now\(\)/)
    }
  } finally {
    if (previousPixelId === undefined) {
      delete process.env.META_PIXEL_ID
    } else {
      process.env.META_PIXEL_ID = previousPixelId
    }
  }
})

test('public notrack URLs omit global and page managed headers before delivery', async () => {
  const site = makeStandardFormSite()
  const noTrackUrls = [
    '/form-headers-pixel?notrack',
    '/form-headers-pixel?no_track=1'
  ]

  for (const originalUrl of noTrackUrls) {
    const trackingEnabled = !requestHasNoTrack({
      originalUrl,
      url: originalUrl,
      query: {},
      headers: {}
    })
    const html = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled,
      preview: false
    })

    assert.equal(trackingEnabled, false)
    assert.doesNotMatch(html, /__rstkGlobalHeader/)
    assert.doesNotMatch(html, /__rstkFormHeader/)
  }

  const trackedUrl = '/form-headers-pixel?notrack=0'
  const trackedHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: !requestHasNoTrack({
      originalUrl: trackedUrl,
      url: trackedUrl,
      query: {},
      headers: {}
    }),
    preview: false
  })

  assert.match(trackedHtml, /__rstkGlobalHeader/)
  assert.match(trackedHtml, /__rstkFormHeader/)
})

test('public Site render resolves variable fields in global/page headers and escapes headline values', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const fields = []
  const globalScript = '<script>window.__rstkVariableGlobal = "global-exacto";</script>'
  const pageScript = '<script>window.__rstkVariablePage = "pagina-exacta";</script>'
  const headlineValue = 'Oferta <Premium> & segura'

  try {
    const globalField = await createVariableField({
      label: `Header global ${suffix}`,
      fieldKey: `site_header_global_${suffix}`,
      value: globalScript
    })
    fields.push(globalField)
    const pageField = await createVariableField({
      label: `Header pagina ${suffix}`,
      fieldKey: `site_header_page_${suffix}`,
      value: pageScript
    })
    fields.push(pageField)
    const headlineField = await createVariableField({
      label: `Titular ${suffix}`,
      fieldKey: `site_headline_${suffix}`,
      value: headlineValue
    })
    fields.push(headlineField)

    const site = makeStandardFormSite()
    site.theme.headerTrackingCode = globalField.parameter
    site.theme.pages[0].headerTrackingCode = pageField.parameter
    site.blocks.unshift({
      id: 'headline-variable',
      siteId: site.id,
      blockType: 'title',
      label: 'Titular',
      content: `Hoy: ${headlineField.parameter}`,
      placeholder: '',
      required: false,
      options: [],
      sortOrder: -1,
      settings: { pageId: 'page-1' },
      createdAt: '',
      updatedAt: ''
    })

    const publicHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.ok(publicHtml.includes(globalScript), 'el header global debe insertar el script exacto')
    assert.ok(publicHtml.includes(pageScript), 'el header de pagina debe insertar el script exacto')
    assert.equal(publicHtml.includes(globalField.parameter), false)
    assert.equal(publicHtml.includes(pageField.parameter), false)
    assert.equal(publicHtml.includes(headlineField.parameter), false)
    assert.match(
      publicHtml,
      /<h1 class="rstk-headline">Hoy: Oferta &lt;Premium&gt; &amp; segura<\/h1>/
    )

    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: true
    })

    assert.equal(previewHtml.includes(globalScript), false)
    assert.equal(previewHtml.includes(pageScript), false)
    assert.doesNotMatch(previewHtml, /__rstkVariableGlobal|__rstkVariablePage/)
    assert.match(
      previewHtml,
      /<h1 class="rstk-headline">Hoy: Oferta &lt;Premium&gt; &amp; segura<\/h1>/
    )
  } finally {
    await deleteVariableFields(fields)
  }
})

test('public Site personalizes contact fields only for the matching first-party visitor or session', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const contactAId = `rstk_contact_site_a_${suffix}`
  const contactBId = `rstk_contact_site_b_${suffix}`
  const visitorA = `visitor_site_a_${suffix}`
  const visitorB = `visitor_site_b_${suffix}`
  const sessionB = `session_site_b_${suffix}`
  const sessionRowId = randomUUID()
  const globalFields = []
  const maliciousValue = '</script><script>window.__rstkContactXss = true</script>'

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, first_name, last_name, visitor_id, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactAId,
        'Ana Privada',
        'Ana',
        'Privada',
        visitorA,
        JSON.stringify([
          { fieldKey: 'plan', label: 'Plan', value: 'Premium Ana' },
          { fieldKey: 'script_payload', label: 'Payload', value: maliciousValue }
        ])
      ]
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, first_name, last_name, custom_fields)
       VALUES (?, ?, ?, ?, ?)`,
      [
        contactBId,
        'Bruno Privado',
        'Bruno',
        'Privado',
        JSON.stringify([{ fieldKey: 'plan', label: 'Plan', value: 'Plan Bruno' }])
      ]
    )
    await db.run(
      `INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, event_id, tracking_source,
        event_name, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'native_site', 'native_site_view', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sessionRowId, sessionB, visitorB, contactBId, `event_site_b_${suffix}`]
    )

    const globalField = await createVariableField({
      label: `Header seguro ${suffix}`,
      fieldKey: `site_safe_header_${suffix}`,
      value: 'valor-global-seguro'
    })
    globalFields.push(globalField)

    const site = makeStandardFormSite()
    site.theme.headerTrackingCode = `<script>window.__rstkSafeGlobal = "${globalField.parameter}";window.__rstkContactHeader = "{{custom.script_payload}}";</script>`
    site.blocks.unshift({
      id: 'headline-contact-variable',
      siteId: site.id,
      blockType: 'title',
      label: 'Titular personalizado',
      content: 'Hola {{contact.first_name}} · {{custom.plan}} · {{custom.script_payload}}',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: -1,
      settings: { pageId: 'page-1' },
      createdAt: '',
      updatedAt: ''
    })

    assert.equal(siteUsesContactTemplateVariables(site), true)
    assert.equal(
      await resolvePublicSitePersonalizationContactId({ site, visitorId: visitorA }),
      contactAId
    )
    assert.equal(
      await resolvePublicSitePersonalizationContactId({ site, sessionId: sessionB }),
      contactBId
    )
    assert.equal(
      await resolvePublicSitePersonalizationContactId({
        site,
        contactId: contactBId,
        visitorId: visitorA
      }),
      '',
      'un contact_id de otra persona no debe ganar sobre la identidad first-party'
    )
    assert.equal(
      await resolvePublicSitePersonalizationContactId({ site, contactId: contactAId }),
      '',
      'contact_id sin visitor/session vinculados nunca debe autorizar datos'
    )

    const anaHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      contactId: contactAId,
      trackingEnabled: true,
      preview: false
    })
    assert.match(anaHtml, /Hola Ana · Premium Ana/)
    assert.match(anaHtml, /&lt;\/script&gt;&lt;script&gt;window\.__rstkContactXss = true&lt;\/script&gt;/)
    assert.doesNotMatch(anaHtml, /<script>window\.__rstkContactXss = true<\/script>/)
    assert.match(anaHtml, /window\.__rstkSafeGlobal = "valor-global-seguro"/)
    assert.match(anaHtml, /window\.__rstkContactHeader = ""/)

    const brunoHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      contactId: contactBId,
      trackingEnabled: true,
      preview: false
    })
    assert.match(brunoHtml, /Hola Bruno · Plan Bruno/)
    assert.doesNotMatch(brunoHtml, /Premium Ana|Ana Privada/)

    const anonymousHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })
    assert.doesNotMatch(anonymousHtml, /Premium Ana|Plan Bruno|Ana Privada|Bruno Privado/)

    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      contactId: contactAId,
      trackingEnabled: true,
      preview: true
    })
    assert.doesNotMatch(previewHtml, /Premium Ana|Ana Privada/)
  } finally {
    await db.run('DELETE FROM sessions WHERE id = ?', [sessionRowId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactAId, contactBId]).catch(() => undefined)
    await deleteVariableFields(globalFields)
  }
})

test('imported HTML asset response resolves variable fields only in its managed header', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const fields = []
  let siteId = ''
  const headerScript = '<script>window.__rstkImportedAssetHeader = "asset-exacto";</script>'
  const rawHtmlToken = `{{variable.raw_html_must_stay_${suffix}}}`

  try {
    const headerField = await createVariableField({
      label: `Header asset ${suffix}`,
      fieldKey: `site_asset_header_${suffix}`,
      value: headerScript
    })
    fields.push(headerField)

    const created = await createImportedSiteFromHtml({
      filename: 'site-variable-assets.zip',
      name: `Site variable assets ${suffix}`,
      siteType: 'landing_page',
      fileBase64: await zipData({
        'index.html': '<!doctype html><html><head><title>Inicio</title></head><body><a href="pages/oferta.html">Oferta</a></body></html>',
        'pages/oferta.html': `<!doctype html><html><head><title>Oferta</title></head><body><h1>${rawHtmlToken}</h1></body></html>`
      })
    })
    siteId = created.site.id
    const offerPage = created.site.theme.pages.find(page => page.importedAssetPath === 'pages/oferta.html')
    assert.ok(offerPage)

    await updateSite(siteId, {
      theme: {
        ...created.site.theme,
        headerTrackingCode: headerField.parameter,
        importedPopupHtml: `<aside data-rstk-imported-popup>${headerField.parameter}</aside>`,
        popupEnabled: true,
        pages: created.site.theme.pages.map(page => (
          page.id === offerPage.id
            ? { ...page, headerTrackingCode: headerField.parameter }
            : page
        ))
      }
    })

    const response = await getImportedSiteAssetResponse(siteId, 'pages/oferta.html', {
      trackingEnabled: true,
      publicHost: 'sites.example.test'
    })
    const html = response?.body?.toString('utf8') || ''

    assert.equal(response?.cacheControl, 'no-store')
    assert.equal((html.match(/__rstkImportedAssetHeader/g) || []).length, 2)
    assert.equal(
      html.split(headerField.parameter).length - 1,
      1,
      'el token del popup importado debe permanecer intacto después de su sanitización'
    )
    assert.ok(html.includes(rawHtmlToken), 'el HTML importado crudo no debe pasar por el resolver de variables')

    const noTrackResponse = await getImportedSiteAssetResponse(siteId, 'pages/oferta.html', {
      trackingEnabled: false,
      publicHost: 'sites.example.test'
    })
    assert.doesNotMatch(noTrackResponse?.body?.toString('utf8') || '', /__rstkImportedAssetHeader/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await deleteVariableFields(fields)
  }
})

test('page Meta default renders base browser PageView and server CAPI PageView only', async () => {
  const previousPixelId = process.env.META_PIXEL_ID
  process.env.META_PIXEL_ID = '1234567890'

  try {
    const site = makeStandardFormSite()
    site.theme.pages[0] = {
      ...site.theme.pages[0],
      metaEventName: 'none',
      metaEventParameters: undefined
    }

    const html = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(html, /fbq\('track', 'PageView'\)/)
    assert.doesNotMatch(html, /window\.ristakMetaTrackSiteEvent\("PageView"/)
    assert.match(html, /eventName: "PageView"/)
    assert.match(html, /fetch\('\/api\/sites\/public\/meta-event'/)
  } finally {
    if (previousPixelId === undefined) {
      delete process.env.META_PIXEL_ID
    } else {
      process.env.META_PIXEL_ID = previousPixelId
    }
  }
})
