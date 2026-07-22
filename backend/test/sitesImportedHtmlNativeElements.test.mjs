import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createBlock,
  createImportedSiteFromHtml,
  createSite,
  deleteSite,
  getSite,
  renderPublicSiteHtml,
  updateBlock,
  updateImportedSiteCodeFiles
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

async function createNativeSourceForm(name) {
  const form = await createSite({
    name,
    title: name,
    siteType: 'standard_form',
    blankCanvas: true,
    theme: {
      template: 'ristak',
      submitText: 'Enviar formulario'
    }
  })

  await createBlock(form.id, {
    blockType: 'email',
    label: 'Correo del lead',
    placeholder: 'tu@correo.com',
    required: true,
    settings: {
      pageId: 'page-1',
      systemFieldKey: 'email'
    }
  })

  return form
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

test('imported HTML custom social profile keeps the AI design and injects connected data', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <section class="ai-social-card" data-rstk-native-element="social-profile" data-rstk-native-id="perfil-principal" data-rstk-native-render="custom" data-rstk-label="Perfil principal">
              <img class="ai-social-avatar" data-rstk-social-avatar src="https://fake.test/avatar.webp" alt="Perfil inventado">
              <strong class="ai-social-name" data-rstk-social-name>Perfil inventado</strong>
              <span class="ai-social-verified" data-rstk-social-verified>Verificado</span>
              <span class="ai-social-platform" data-rstk-social-platform>Red inventada</span>
              <span class="ai-social-followers"><b data-rstk-social-followers>999 mil</b> seguidores</span>
              <small class="ai-social-subtitle" data-rstk-social-subtitle>Texto inventado</small>
            </section>
          </main>
        </body>
      </html>
    `, `HTML custom social profile ${Date.now()}`)
    siteId = site.id

    const siteWithSocialProfile = await createBlock(site.id, {
      blockType: 'social_profile',
      label: 'Perfil principal',
      content: 'Perfil de red social',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'perfil-principal',
        importedHtmlNativeType: 'social_profile',
        importedHtmlNativeRenderMode: 'custom',
        platform: 'instagram',
        brandName: 'Ristak Oficial',
        brandSubtitle: 'Cuenta de Instagram conectada',
        brandAvatar: 'https://example.test/ristak-avatar.webp',
        followers: '24 mil',
        brandVerified: false,
        socialAutoSync: true,
        socialSourceProfileId: 'instagram:ig_1'
      }
    })

    let currentSite = await getSite(site.id, { includeBlocks: true })
    let html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: false
    })

    assert.match(html, /class="ai-social-card rstk-imported-native-slot rstk-imported-native-social-profile rstk-imported-native-custom"/)
    assert.match(html, /data-rstk-native-mounted="true"/)
    assert.match(html, /data-rstk-native-type="social_profile"/)
    assert.match(html, /data-rstk-native-slot-id="perfil-principal"/)
    assert.match(html, /data-rstk-social-platform-value="instagram"/)
    assert.match(html, /src="https:\/\/example\.test\/ristak-avatar\.webp"/)
    assert.match(html, /alt="Ristak Oficial"/)
    assert.match(html, /data-rstk-social-name>Ristak Oficial</)
    assert.match(html, /data-rstk-social-platform>Instagram</)
    assert.match(html, /data-rstk-social-followers>24 mil</)
    assert.match(html, /data-rstk-social-subtitle>Cuenta de Instagram conectada</)
    assert.match(html, /data-rstk-social-verified data-rstk-social-visible="false" hidden aria-hidden="true">Verificado</)
    assert.doesNotMatch(html, /Perfil inventado|999 mil|Red inventada|Texto inventado|fake\.test/)
    assert.doesNotMatch(html, /<section class="rstk-chrome rstk-social-profile rstk-social-profile-block/)

    const socialBlock = siteWithSocialProfile.blocks.find(currentBlock => currentBlock.blockType === 'social_profile')
    assert.ok(socialBlock)
    await updateBlock(site.id, socialBlock.id, {
      settings: {
        ...socialBlock.settings,
        brandVerified: true
      }
    })
    currentSite = await getSite(site.id, { includeBlocks: true })
    html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: false
    })

    assert.match(html, /data-rstk-social-verified data-rstk-social-visible="true">Verificado</)
    assert.doesNotMatch(html, /data-rstk-social-visible="true"[^>]*hidden/)
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

test('imported HTML draft code preview renders native slots through the Ristak runtime without saving code', async () => {
  let siteId = ''

  try {
    const originalHtml = `
      <!doctype html>
      <html>
        <body>
          <main>
            <h1>Original headline</h1>
            <div data-rstk-native-element="payment" data-rstk-native-id="checkout-principal" data-rstk-label="Pago principal"></div>
          </main>
        </body>
      </html>
    `
    const site = await createImportedNativeSite(originalHtml, `HTML native draft runtime ${Date.now()}`)
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
          mode: 'test',
          gateway: 'stripe',
          amount: 1200,
          currency: 'MXN',
          productName: 'Consulta con borrador',
          buttonText: 'Pagar consulta'
        }
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const draftHtml = originalHtml.replace('Original headline', 'Draft headline from code editor')
    const draftPreviewHtml = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true,
      importedNativePreviewMock: true,
      draftImportedCodeFiles: [{ path: '', content: draftHtml }]
    })

    assert.match(draftPreviewHtml, /Draft headline from code editor/)
    assert.doesNotMatch(draftPreviewHtml, /Original headline/)
    assert.match(draftPreviewHtml, /data-rstk-native-mounted="true"/)
    assert.match(draftPreviewHtml, /data-rstk-payment-preview="true"/)
    assert.match(draftPreviewHtml, /Consulta con borrador/)
    assert.doesNotMatch(draftPreviewHtml, /data-rstk-checkout/)

    const storedPreviewHtml = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true,
      importedNativePreviewMock: true
    })

    assert.match(storedPreviewHtml, /Original headline/)
    assert.doesNotMatch(storedPreviewHtml, /Draft headline from code editor/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML page-asset draft preview uses the active file before native slot rendering', async () => {
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      name: `HTML native page asset draft ${Date.now()}`,
      filename: `asset-draft-${Date.now()}.html`,
      siteType: 'landing_page',
      pages: [{
        id: 'page-landing',
        title: 'Landing',
        filename: 'Landing-01.html',
        html: `
          <!doctype html>
          <html>
            <body>
              <main>
                <h1>Asset original headline</h1>
                <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></section>
              </main>
            </body>
          </html>
        `
      }]
    })
    siteId = created.site.id

    await createBlock(siteId, {
      blockType: 'calendar_embed',
      label: 'Agenda',
      settings: {
        pageId: 'page-landing',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-slot',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'ristak',
        calendarId: 'cal_asset_draft',
        calendarSlug: 'agenda-asset-draft',
        calendarName: 'Agenda asset draft'
      }
    })

    const currentSite = await getSite(siteId, { includeBlocks: true })
    const draftPreviewHtml = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-landing',
      trackingEnabled: false,
      preview: true,
      draftImportedCodeFiles: [{
        path: 'Landing-01.html',
        content: `
          <!doctype html>
          <html>
            <body>
              <main>
                <h1>Asset draft headline from code editor</h1>
                <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></section>
              </main>
            </body>
          </html>
        `
      }]
    })

    assert.match(draftPreviewHtml, /Asset draft headline from code editor/)
    assert.doesNotMatch(draftPreviewHtml, /Asset original headline/)
    assert.match(draftPreviewHtml, /data-rstk-native-slot-id="agenda-slot"/)
    assert.match(draftPreviewHtml, /\/api\/sites\/public\/calendar-preview\/agenda-asset-draft\?test=1/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML draft code preview renders form, calendar, payment and video slots with the same Ristak runtime', async () => {
  let siteId = ''
  let formSiteId = ''

  try {
    const sourceForm = await createNativeSourceForm(`Fuente nativa HTML ${Date.now()}`)
    formSiteId = sourceForm.id

    const originalHtml = `
      <!doctype html>
      <html>
        <body>
          <main>
            <h1>Original all native slots</h1>
            <section data-rstk-native-element="form" data-rstk-native-id="lead-form" data-rstk-label="Formulario principal"></section>
            <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-label="Agenda principal"></section>
            <section data-rstk-native-element="payment" data-rstk-native-id="checkout-principal" data-rstk-label="Pago principal"></section>
            <section data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
          </main>
        </body>
      </html>
    `
    const site = await createImportedNativeSite(originalHtml, `HTML all native draft ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'form_embed',
      label: 'Formulario principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'lead-form',
        importedHtmlNativeType: 'form',
        importedHtmlNativeRenderMode: 'ristak',
        formSiteId: sourceForm.id,
        completionAction: 'form_default'
      }
    })

    await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Agenda principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-slot',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'ristak',
        calendarId: 'cal_all_native',
        calendarSlug: 'agenda-all-native',
        calendarName: 'Agenda all native'
      }
    })

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
          mode: 'test',
          gateway: 'stripe',
          amount: 1990,
          currency: 'MXN',
          productName: 'Paquete completo',
          buttonText: 'Pagar paquete'
        }
      }
    })

    await createBlock(site.id, {
      blockType: 'video',
      label: 'Video principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/all-native.mp4',
        videoControlsMode: 'overlay',
        videoActions: [{
          id: 'video-gate-action',
          action: 'open_video_form',
          timeSeconds: 3,
          before: 'unchanged'
        }],
        videoFormGateEnabled: true,
        videoFormGateTriggerSeconds: 3,
        videoFormGateTitle: 'Antes de seguir',
        videoFormGateSubmitText: 'Continuar video',
        videoFormGateFormSiteId: sourceForm.id,
        videoFormGateEmbeddedSiteName: sourceForm.name,
        videoFormGateEmbeddedTheme: {
          submitText: 'Continuar video'
        },
        videoFormGateEmbeddedBlocks: [{
          id: 'video-gate-email',
          siteId: sourceForm.id,
          blockType: 'email',
          label: 'Correo para video',
          placeholder: 'video@correo.com',
          required: true,
          sortOrder: 0,
          settings: {
            pageId: 'video-form-gate',
            systemFieldKey: 'email',
            validation: 'email'
          }
        }]
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const draftHtml = originalHtml.replace('Original all native slots', 'Draft all native slots')
    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true,
      importedNativePreviewMock: true,
      draftImportedCodeFiles: [{ path: '', content: draftHtml }]
    })

    assert.match(html, /Draft all native slots/)
    assert.doesNotMatch(html, /Original all native slots/)
    assert.match(html, /rstk-imported-native-form-frame/)
    assert.match(html, /ristak:form-embed-height/)
    assert.match(html, /ristak:form-navigate/)
    assert.match(html, /data-site-form/)
    assert.match(html, /rstk-embedded-form/)
    assert.match(html, /Correo del lead/)
    assert.match(html, /iframe class="rstk-embed rstk-calendar-embed"/)
    assert.match(html, /\/api\/sites\/public\/calendar-preview\/agenda-all-native\?test=1/)
    assert.match(html, /data-rstk-payment-preview="true"/)
    assert.match(html, /Paquete completo/)
    assert.match(html, /class="rstk-video[^"]*rstk-video-player/)
    assert.match(html, /data-rstk-video-src="https:\/\/cdn\.example\.test\/all-native\.mp4"/)
    assert.match(html, /data-rstk-video-form-gate/)
    assert.match(html, /Correo para video/)
    assert.match(html, /Continuar video/)
    assert.match(html, /window\.ristakVideoActionsRuntimeLoaded/)
    assert.match(html, /window\.ristakVideoFormGateRuntimeLoaded/)
    assert.match(html, /\/api\/sites\/public\/submit/)
    assert.doesNotMatch(html, /Selecciona un formulario de Ristak/)
    assert.doesNotMatch(html, /Selecciona un calendario de Ristak/)
    assert.doesNotMatch(html, /Configura el pago de Ristak/)
    assert.doesNotMatch(html, /Configura el video de Ristak/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    if (formSiteId) await deleteSite(formSiteId).catch(() => undefined)
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
            <input type="date" data-rstk-calendar-date>
            <button type="button" data-rstk-calendar-load-slots>Ver horarios</button>
            <form data-rstk-calendar-book-form>
              <select data-rstk-calendar-time></select>
              <input data-rstk-calendar-name>
              <input data-rstk-calendar-email>
              <button type="submit">Agendar</button>
            </form>
            <p data-rstk-calendar-message></p>
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
    assert.match(html, /data-rstk-calendar-load-slots/)
    assert.match(html, /data-rstk-calendar-book-form/)
    assert.match(html, /window\.ristakCalendarGetSlots/)
    assert.match(html, /window\.ristakCalendarBook/)
    assert.match(html, /rstkCalendarWired/)
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
        <head>
          <style>
            .ai-video-slot {
              width: 360px !important;
              max-width: 360px !important;
              height: 640px !important;
              min-height: 640px !important;
              aspect-ratio: 9 / 16 !important;
              overflow: hidden !important;
              padding-top: 177% !important;
            }
          </style>
        </head>
        <body>
          <main>
            <section class="ai-video-slot" style="height:640px;aspect-ratio:9/16" data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
            <button id="cta-final" data-rstk-editable="true" data-rstk-edit-type="button" data-rstk-edit-id="cta-final">Continuar</button>
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
        responsive: { mobile: { mediaWidth: 78 } },
        videoActions: [{
          id: 'action-1',
          timeSeconds: 2,
          action: 'show',
          targetBlockId: 'cta-final',
          targetBlockIds: ['cta-final'],
          before: 'hidden'
        }, {
          id: 'action-2',
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
    assert.match(html, /data-rstk-video-orientation-mode="auto"/)
    assert.match(html, /data-rstk-video-src="https:\/\/cdn\.example\.test\/video\.mp4"/)
    assert.match(html, /data-rstk-video-actions=/)
    assert.match(html, /https:\/\/example\.test\/gracias/)
    assert.match(html, /window\.ristakVideoActionsRuntimeLoaded/)
    assert.match(html, /const previewEnabled = video\.getAttribute\('data-rstk-video-preview'\) === 'true'/)
    assert.match(html, /const startPreviewLoop = \(\) =>/)
    assert.match(html, /const syncVideoOrientation = \(host, video\) =>/)
    assert.equal((html.match(/const HLS_SCRIPT_URL/g) || []).length, 1)
    assert.match(html, /\.rstk-imported-native-video\[data-rstk-native-mounted="true"\]\{width:100%!important;max-width:none!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;padding:var\(--rstk-native-slot-padding,0\)!important;background-color:var\(--rstk-native-slot-background,transparent\)!important;box-shadow:none!important\}/)
    assert.match(html, /\.rstk-imported-native-video > \.rstk-video\{width:var\(--rstk-media-width,100%\);margin-left:var\(--rstk-media-margin-left,auto\);margin-right:var\(--rstk-media-margin-right,auto\)\}/)
    assert.match(html, /\.rstk-imported-native-video > \.rstk-video-portrait\{width:var\(--rstk-media-width,44%\)\}/)
    assert.match(html, /@media \(max-width:760px\)\{\.rstk-imported-native-video > \.rstk-video-portrait\.rstk-video-wauto:not\(\.rstk-video-form-gate-fit-wide\)\{width:100%;margin-left:auto;margin-right:auto\}\}/)
    assert.match(html, /style data-rstk-imported-native-theme/)
    assert.match(html, /<style data-rstk-responsive>@media \(max-width:640px\)\{\[data-rstk-block-id="[^"]+"\]\{--rstk-media-width:78%!important\}\}<\/style>/)
    assert.match(html, /\.rstk-imported-native-slot \.rstk-video-form-gate/)
    assert.match(html, /id="cta-final"[^>]*data-rstk-video-action-target="cta-final"/)
    assert.match(html, /id="cta-final"[^>]*data-rstk-video-action-hidden="true"/)
    assert.doesNotMatch(html, /Configura el video de Ristak/)

    const previewHtml = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: true })
    assert.match(previewHtml, /const PREVIEW_SAFE = true;/)
    assert.match(previewHtml, /data-rstk-video-preview="true"/)
    assert.match(previewHtml, /startPreviewLoop\(\)/)
    assert.match(previewHtml, /id="cta-final"[^>]*data-rstk-video-action-hidden="true"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('responsive imported video slots use the configured sibling until mobile gets its own file', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <head>
          <style>
            .video-desktop { display: block; }
            .video-mobile { display: none; }
            @media (max-width: 640px) {
              .video-desktop { display: none; }
              .video-mobile { display: block; }
            }
          </style>
        </head>
        <body>
          <section class="video-desktop" data-rstk-native-element="video" data-rstk-native-id="video-presentacion-escritorio"></section>
          <section class="video-mobile" data-rstk-native-element="video" data-rstk-native-id="video-presentacion-movil"></section>
        </body>
      </html>
    `, `HTML responsive native video ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'video',
      label: 'Video computadora',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-presentacion-escritorio',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-escritorio.mp4'
      }
    })

    let currentSite = await getSite(site.id, { includeBlocks: true })
    let html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: false })

    assert.match(html, /data-rstk-native-slot-id="video-presentacion-escritorio"/)
    assert.match(html, /data-rstk-native-slot-id="video-presentacion-movil"/)
    assert.equal((html.match(/data-rstk-video-src="https:\/\/cdn\.example\.test\/video-escritorio\.mp4"/g) || []).length, 2)
    assert.doesNotMatch(html, /Configura el video de Ristak/)

    await createBlock(site.id, {
      blockType: 'video',
      label: 'Video móvil',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-presentacion-movil',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-movil.mp4'
      }
    })

    currentSite = await getSite(site.id, { includeBlocks: true })
    html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: false })

    assert.equal((html.match(/data-rstk-video-src="https:\/\/cdn\.example\.test\/video-escritorio\.mp4"/g) || []).length, 1)
    assert.equal((html.match(/data-rstk-video-src="https:\/\/cdn\.example\.test\/video-movil\.mp4"/g) || []).length, 1)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML native video slots keep the customized Ristak player in the published site', async () => {
  let siteId = ''
  const assetId = `site_imported_stream_${Date.now()}`
  const storageUrl = `https://cdn.example.test/sites/${assetId}.mp4`
  const streamVideoId = `stream-${assetId}`

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status,
        storage_provider, module, module_entity_id, is_public, metadata_json
      ) VALUES (?, 'default', 'video.mp4', 'video.mp4', ?, ?, 'video/mp4', 'video', 'mp4', 128, 128, 128, 'ready', 'bunny', 'sites', ?, 1, ?)`,
      [
        assetId,
        `sites/${assetId}.mp4`,
        storageUrl,
        'site_imported_native_video',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId
          }
        })
      ]
    )

    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <section data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
          </main>
        </body>
      </html>
    `, `HTML native live player ${Date.now()}`)
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
        mediaUrl: storageUrl,
        videoControlsMode: 'clean',
        videoControlBar: true,
        videoPlayerRadius: 27,
        videoPlayShape: 'round',
        videoPlaySize: 88
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(html, /data-rstk-native-slot-id="video-principal"/)
    assert.match(html, /class="rstk-video[^\"]*rstk-video-player/)
    assert.match(html, /rstk-video-custom-controls/)
    assert.match(html, new RegExp(`data-rstk-video-src="${storageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
    assert.match(html, /--rstk-video-radius:27px/)
    assert.match(html, /rstk-video-play-shape-round/)
    assert.match(html, /--rstk-video-play-size:88px/)
    assert.match(html, /data-rstk-video-provider="bunny_stream"/)
    assert.match(html, new RegExp(`data-rstk-stream-video-id="${streamVideoId}"`))
    assert.doesNotMatch(html, /rstk-video-stream-frame/)
    assert.doesNotMatch(html, /iframe\.mediadelivery\.net\/embed/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('declarative HTML video rules reconcile by stable id without deleting manual actions', async () => {
  let siteId = ''

  const renderPage = (rulesAttribute = '') => `
    <!doctype html>
    <html>
      <body>
        <main>
          <div
            data-rstk-native-element="video"
            data-rstk-native-id="video-principal"
            data-rstk-label="Video principal"
            ${rulesAttribute}
          ></div>
          <section data-rstk-video-action-target="oferta-final" data-rstk-label="Oferta final">
            <button id="comprar-ahora">Comprar ahora</button>
          </section>
        </main>
      </body>
    </html>
  `

  const rulesAttribute = rules => `data-rstk-video-rules='${JSON.stringify(rules)}'`

  try {
    const site = await createImportedNativeSite(
      renderPage(),
      `HTML declarative video rules ${Date.now()}`
    )
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
        mediaUrl: 'https://cdn.example.test/declarative-video.mp4',
        videoActions: [{
          id: 'accion-manual',
          action: 'redirect',
          timeSeconds: 12,
          redirectUrl: 'https://example.test/manual'
        }]
      }
    })

    const initialRules = [{
      id: 'mostrar-oferta',
      triggerType: 'unique_watched_percent',
      triggerValue: 50,
      action: 'show',
      targetBlockIds: ['oferta-final'],
      before: 'hidden'
    }]

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage(rulesAttribute(initialRules)) }]
    })

    let currentSite = await getSite(site.id, { includeBlocks: true })
    let videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.ok(videoBlock)
    assert.deepEqual(videoBlock.settings.importedHtmlVideoRuleIds, ['mostrar-oferta'])
    assert.equal(typeof videoBlock.settings.importedHtmlVideoRulesSignature, 'string')
    assert.ok(videoBlock.settings.importedHtmlVideoRulesSignature)
    assert.equal(videoBlock.settings.videoActions.length, 2)
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'accion-manual')?.redirectUrl, 'https://example.test/manual')
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.triggerType, 'unique_watched_percent')
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.triggerValue, 50)

    await updateBlock(site.id, videoBlock.id, {
      settings: {
        ...videoBlock.settings,
        videoActions: videoBlock.settings.videoActions.map(rule => rule.id === 'mostrar-oferta'
          ? {
            ...rule,
            action: 'hide',
            before: 'visible',
            targetBlockId: 'comprar-ahora',
            targetBlockIds: ['comprar-ahora']
          }
          : rule)
      }
    })

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage(rulesAttribute(initialRules)) }]
    })

    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.action, 'hide')
    assert.deepEqual(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.targetBlockIds, ['comprar-ahora'])

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage() }]
    })

    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoActions.length, 2)
    assert.ok(videoBlock.settings.videoActions.some(rule => rule.id === 'mostrar-oferta'))

    const updatedRules = [{
      id: 'mostrar-oferta',
      trigger: { type: 'playback_seconds', value: 180 },
      action: 'show',
      targetIds: ['oferta-final'],
      before: 'hidden'
    }, {
      id: 'ocultar-oferta',
      triggerType: 'timeline_reached',
      triggerValue: 300,
      action: 'hide',
      targetBlockIds: ['oferta-final'],
      before: 'visible'
    }]

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage(rulesAttribute(updatedRules)) }]
    })

    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoActions.length, 3)
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.triggerType, 'playback_seconds')
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.triggerValue, 180)
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.action, 'hide')
    assert.deepEqual(videoBlock.settings.videoActions.find(rule => rule.id === 'mostrar-oferta')?.targetBlockIds, ['comprar-ahora'])
    assert.equal(videoBlock.settings.videoActions.find(rule => rule.id === 'ocultar-oferta')?.timeSeconds, 300)

    await updateImportedSiteCodeFiles(site.id, {
      files: [{
        path: '',
        content: renderPage(rulesAttribute([{ id: 'mostrar-oferta', deleted: true }, { id: 'ocultar-oferta', deleted: true }]))
      }]
    })

    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.deepEqual(videoBlock.settings.importedHtmlVideoRuleIds, [])
    assert.deepEqual(videoBlock.settings.videoActions.map(rule => rule.id), ['accion-manual'])
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('a newly connected imported video inherits declarative rules already present in the HTML', async () => {
  let siteId = ''

  try {
    const rules = [{
      id: 'mostrar-formulario',
      triggerType: 'playback_seconds',
      triggerValue: 180,
      action: 'show',
      targetBlockIds: ['formulario-oferta'],
      before: 'hidden',
      value: 'Oferta > formulario'
    }]
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <div
            data-rstk-native-element="video"
            data-rstk-native-id="video-principal"
            data-rstk-video-rules='${JSON.stringify(rules)}'
          ></div>
          <form id="formulario-oferta" data-rstk-form-id="formulario-oferta"></form>
        </body>
      </html>
    `, `HTML video rules before mapping ${Date.now()}`)
    siteId = site.id

    const saved = await createBlock(site.id, {
      blockType: 'video',
      label: 'Video principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-before-mapping.mp4'
      }
    })

    const videoBlock = saved.blocks.find(block => block.blockType === 'video')
    assert.ok(videoBlock)
    assert.equal(videoBlock.settings.videoActions.length, 1)
    assert.equal(videoBlock.settings.videoActions[0].id, 'mostrar-formulario')
    assert.equal(videoBlock.settings.videoActions[0].triggerType, 'playback_seconds')
    assert.equal(videoBlock.settings.videoActions[0].triggerValue, 180)
    assert.equal(videoBlock.settings.videoActions[0].value, 'Oferta > formulario')
    assert.deepEqual(videoBlock.settings.importedHtmlVideoRuleIds, ['mostrar-formulario'])
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('draft changes made before connecting an imported video override declarative defaults', async () => {
  let siteId = ''

  try {
    const rules = [{
      id: 'mostrar-oferta',
      triggerType: 'unique_watched_percent',
      triggerValue: 50,
      action: 'show',
      targetBlockIds: ['oferta-final'],
      before: 'hidden'
    }]
    const html = `
      <!doctype html>
      <html>
        <body>
          <div
            data-rstk-native-element="video"
            data-rstk-native-id="video-principal"
            data-rstk-video-rules='${JSON.stringify(rules)}'
          ></div>
          <section id="oferta-final" data-rstk-video-action-target="oferta-final"></section>
        </body>
      </html>
    `
    const site = await createImportedNativeSite(html, `HTML video draft override ${Date.now()}`)
    siteId = site.id

    const saved = await createBlock(site.id, {
      blockType: 'video',
      label: 'Video principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-draft-override.mp4',
        videoActions: [{
          ...rules[0],
          triggerValue: 65,
          action: 'hide',
          before: 'visible'
        }]
      }
    })

    let videoBlock = saved.blocks.find(block => block.blockType === 'video')
    assert.ok(videoBlock)
    assert.equal(videoBlock.settings.videoActions[0].triggerValue, 65)
    assert.equal(videoBlock.settings.videoActions[0].action, 'hide')
    assert.equal(videoBlock.settings.importedHtmlVideoRuleDeclarations['mostrar-oferta'].triggerValue, 50)

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: html }]
    })
    const currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoActions[0].triggerValue, 65)
    assert.equal(videoBlock.settings.videoActions[0].action, 'hide')
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML native slots and video action targets stay scoped to the active page', async () => {
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      name: `HTML native page scoped slots ${Date.now()}`,
      filename: `native-page-scope-${Date.now()}.html`,
      siteType: 'landing_page',
      pages: [
        {
          title: 'Página video uno',
          filename: 'index.html',
          html: `
            <!doctype html>
            <html>
              <body>
                <main>
                  <section data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
                  <button id="cta-final">CTA página uno</button>
                </main>
              </body>
            </html>
          `
        },
        {
          title: 'Página video dos',
          filename: 'video-dos.html',
          html: `
            <!doctype html>
            <html>
              <body>
                <main>
                  <section data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></section>
                  <button id="cta-final">CTA página dos</button>
                </main>
              </body>
            </html>
          `
        }
      ]
    })
    siteId = created.site.id

    const pageOneId = created.site.theme.pages.find(page => page.title === 'Página video uno')?.id
    const pageTwoId = created.site.theme.pages.find(page => page.title === 'Página video dos')?.id
    assert.ok(pageOneId)
    assert.ok(pageTwoId)

    await createBlock(siteId, {
      blockType: 'video',
      label: 'Video principal página uno',
      settings: {
        pageId: pageOneId,
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-page-one.mp4',
        videoActions: [{
          id: 'page-one-action',
          timeSeconds: 3,
          action: 'show',
          targetBlockId: 'cta-final',
          targetBlockIds: ['cta-final'],
          before: 'hidden'
        }]
      }
    })

    await createBlock(siteId, {
      blockType: 'video',
      label: 'Video principal página dos',
      settings: {
        pageId: pageTwoId,
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-page-two.mp4',
        videoActions: []
      }
    })

    const currentSite = await getSite(siteId, { includeBlocks: true })
    const pageOneHtml = await renderPublicSiteHtml(currentSite, { pageId: pageOneId, trackingEnabled: false, preview: false })
    const pageTwoHtml = await renderPublicSiteHtml(currentSite, { pageId: pageTwoId, trackingEnabled: false, preview: false })

    assert.match(pageOneHtml, /video-page-one\.mp4/)
    assert.doesNotMatch(pageOneHtml, /video-page-two\.mp4/)
    assert.match(pageOneHtml, /id="cta-final"[^>]*data-rstk-video-action-hidden="true"/)

    assert.match(pageTwoHtml, /video-page-two\.mp4/)
    assert.doesNotMatch(pageTwoHtml, /video-page-one\.mp4/)
    assert.doesNotMatch(pageTwoHtml, /id="cta-final"[^>]*data-rstk-video-action-hidden="true"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('published imported HTML native calendar slots use the live booking iframe, not editor preview', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-slot" data-rstk-native-render="ristak"></section>
        </body>
      </html>
    `, `HTML native calendar live ${Date.now()}`)
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
        calendarId: 'cal_live',
        calendarSlug: 'consulta-en-vivo',
        calendarName: 'Consulta en vivo'
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: true, preview: false })

    assert.match(html, /data-rstk-native-slot-id="agenda-slot"/)
    assert.match(html, /iframe class="rstk-embed rstk-calendar-embed"/)
    assert.match(html, /\/calendar\/consulta-en-vivo\?/)
    assert.doesNotMatch(html, /\/api\/sites\/public\/calendar-preview\//)
    assert.doesNotMatch(html, /editor_preview=1/)
    assert.doesNotMatch(html, /preview=1/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('published imported HTML custom calendar slots expose live booking helpers', async () => {
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
    `, `HTML custom calendar live ${Date.now()}`)
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
        calendarId: 'cal_custom_live',
        calendarSlug: 'agenda-custom-live',
        calendarName: 'Agenda personalizada live'
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: true, preview: false })

    assert.match(html, /data-rstk-native-slot-id="agenda-custom"/)
    assert.match(html, /data-hook="load-slots"/)
    assert.match(html, /window\.ristakCalendarGetSlots/)
    assert.match(html, /window\.ristakCalendarBook/)
    assert.match(html, /\/api\/calendars\/public\/agenda-custom-live\/free-slots/)
    assert.match(html, /\/api\/calendars\/public\/agenda-custom-live\/appointments/)
    assert.doesNotMatch(html, /Vista previa sin agendar/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('published imported HTML native payment slots use live checkout runtime, not the disabled preview mock', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <main>
            <div data-rstk-native-element="payment" data-rstk-native-id="checkout-principal" data-rstk-label="Pago principal"></div>
          </main>
        </body>
      </html>
    `, `HTML native payment live ${Date.now()}`)
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
          amount: 750,
          currency: 'MXN',
          productName: 'Reserva premium',
          buttonText: 'Pagar reserva'
        }
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: true, preview: false })

    assert.match(html, /data-rstk-native-slot-id="checkout-principal"/)
    assert.match(html, /data-rstk-checkout/)
    assert.match(html, /\/api\/sites\/public\/checkout\/init/)
    assert.match(html, /var INIT_URL = '\/api\/sites\/public\/checkout\/init'/)
    assert.doesNotMatch(html, /<section[^>]+data-rstk-payment-preview="true"/)
    assert.doesNotMatch(html, /rstk-checkout-fields-mock/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
