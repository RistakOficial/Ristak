import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBlock,
  createImportedSiteFromHtml,
  deleteSite,
  getSite,
  renderPublicSiteHtml
} from '../src/services/sitesService.js'

async function createImportedNativeSite(html, name) {
  const created = await createImportedSiteFromHtml({
    filename: `${name}.html`,
    fileBase64: Buffer.from(html, 'utf8').toString('base64'),
    siteType: 'landing_page',
    name
  })
  return created.site
}

test('imported HTML native payment slots render the real Ristak checkout runtime', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <h1>Consulta premium</h1>
            <div class="checkout-shell" data-rstk-native-element="payment" data-rstk-native-id="checkout-principal" data-rstk-label="Pago principal"></div>
          </main>
        </body>
      </html>
    `, `HTML native payment ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'payment',
      label: 'Pago principal',
      content: 'Pago requerido',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'checkout-principal',
        importedHtmlNativeType: 'payment',
        importedHtmlNativeRenderMode: 'ristak',
        paymentGate: {
          enabled: true,
          gateway: 'stripe',
          amount: 1500,
          currency: 'MXN',
          productName: 'Consulta premium',
          buttonText: 'Pagar'
        }
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: true })

    assert.match(html, /data-rstk-native-mounted="true"/)
    assert.match(html, /data-rstk-native-slot-id="checkout-principal"/)
    assert.match(html, /data-rstk-checkout/)
    assert.match(html, /data-payment-block-id="/)
    assert.match(html, /Consulta premium/)
    assert.match(html, /\/api\/sites\/public\/checkout\/init/)
    assert.doesNotMatch(html, /Configura el pago de Ristak/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML native payment slots render editor payment mock from preview draft blocks', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <h1>Reserva tu diagnostico</h1>
            <div class="checkout-shell" data-rstk-native-element="payment" data-rstk-native-id="checkout-principal" data-rstk-label="Pago principal"></div>
          </main>
        </body>
      </html>
    `, `HTML native payment draft ${Date.now()}`)
    siteId = site.id

    const currentSite = await getSite(site.id, { includeBlocks: true })
    currentSite.blocks = [{
      id: 'imported-native-draft-payment',
      siteId: site.id,
      blockType: 'payment',
      label: 'Pago principal',
      content: 'Pago requerido',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'checkout-principal',
        importedHtmlNativeType: 'payment',
        importedHtmlNativeRenderMode: 'ristak',
        paymentGate: {
          enabled: true,
          mode: 'test',
          gateway: 'stripe',
          amount: 985,
          currency: 'MXN',
          productName: 'Diagnostico inicial',
          description: 'Completa el pago para reservar.',
          buttonText: 'Completar pago'
        }
      }
    }]

    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true,
      importedNativePreviewMock: true
    })

    assert.match(html, /data-rstk-native-mounted="true"/)
    assert.match(html, /data-rstk-payment-preview="true"/)
    assert.match(html, /rstk-checkout-fields-mock/)
    assert.match(html, /Número de tarjeta/)
    assert.match(html, /Diagnostico inicial/)
    assert.match(html, /Completar pago/)
    assert.doesNotMatch(html, /data-rstk-checkout/)
    assert.doesNotMatch(html, /\/api\/sites\/public\/checkout\/init/)
    assert.doesNotMatch(html, /Configura el pago de Ristak/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML native calendar slots render the selected Ristak calendar iframe and bridge', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></section>
        </body>
      </html>
    `, `HTML native calendar ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Agenda',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-slot',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'ristak',
        calendarId: 'cal_123',
        calendarSlug: 'consulta-inicial',
        calendarName: 'Consulta inicial'
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: true })

    assert.match(html, /data-rstk-native-slot-id="agenda-slot"/)
    assert.match(html, /iframe class="rstk-embed rstk-calendar-embed"/)
    assert.match(html, /\/api\/sites\/public\/calendar-preview\/consulta-inicial\?test=1/)
    assert.match(html, /ristak:calendar-embed-height/)
    assert.doesNotMatch(html, /Selecciona un calendario de Ristak/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML custom calendar slots keep custom markup and expose mapped Ristak booking helpers', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <section class="agenda-custom" data-rstk-native-element="calendar" data-rstk-native-id="agenda-custom" data-rstk-native-render="custom">
            <button type="button" data-hook="load-slots">Ver horarios</button>
          </section>
        </body>
      </html>
    `, `HTML custom calendar ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Agenda custom',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-custom',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'custom',
        calendarId: 'cal_custom',
        calendarSlug: 'agenda-custom-slug',
        calendarName: 'Agenda personalizada',
        calendarCompletionAction: 'redirect',
        calendarCompletionRedirectUrl: 'https://example.test/gracias'
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: true })

    assert.match(html, /data-rstk-native-slot-id="agenda-custom"/)
    assert.match(html, /data-rstk-calendar-slug="agenda-custom-slug"/)
    assert.match(html, /data-hook="load-slots"/)
    assert.match(html, /window\.ristakCalendarGetSlots/)
    assert.match(html, /window\.ristakCalendarBook/)
    assert.match(html, /\/api\/calendars\/public\/agenda-custom-slug\/free-slots/)
    assert.match(html, /\/api\/calendars\/public\/agenda-custom-slug\/appointments/)
    assert.match(html, /https:\/\/example\.test\/gracias/)
    assert.doesNotMatch(html, /iframe class="rstk-embed rstk-calendar-embed"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML native video slots render the real Ristak player and video actions runtime', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <section data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
          </main>
        </body>
      </html>
    `, `HTML native video ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'video',
      label: 'Video principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video.mp4',
        videoControlsMode: 'overlay',
        videoActions: [{
          id: 'action-1',
          timeSeconds: 4,
          action: 'redirect',
          redirectUrl: 'https://example.test/gracias'
        }]
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: false })

    assert.match(html, /data-rstk-native-slot-id="video-principal"/)
    assert.match(html, /class="rstk-video[^"]*rstk-video-player/)
    assert.match(html, /data-rstk-video-src="https:\/\/cdn\.example\.test\/video\.mp4"/)
    assert.match(html, /data-rstk-video-actions=/)
    assert.match(html, /https:\/\/example\.test\/gracias/)
    assert.match(html, /window\.ristakVideoActionsRuntimeLoaded/)
    assert.doesNotMatch(html, /Configura el video de Ristak/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
