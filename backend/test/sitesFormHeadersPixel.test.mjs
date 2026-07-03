import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

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
