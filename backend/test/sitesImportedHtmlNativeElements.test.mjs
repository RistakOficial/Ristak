import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

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
            <section class="ai-social-card" style="color:inherit;height:100vh!important;min-height:960px!important;max-height:1200px!important;aspect-ratio:1/1!important;flex:1 1 auto!important;margin:0 0 80vh!important" data-rstk-native-element="social-profile" data-rstk-native-id="perfil-principal" data-rstk-native-render="custom" data-rstk-label="Perfil principal">
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
    assert.match(html, /style="color:inherit"/)
    assert.doesNotMatch(html, /style="[^"]*(?:height|min-height|max-height|aspect-ratio|flex|margin):/)
    assert.match(html, /\.rstk-imported-native-social-profile\.rstk-imported-native-custom\[data-rstk-native-mounted="true"\]\{width:100%!important;height:auto!important;min-height:0!important;max-height:none!important;block-size:auto!important;min-block-size:0!important;max-block-size:none!important;aspect-ratio:auto!important;flex-grow:0!important;flex-shrink:0!important;margin-bottom:0!important\}/)
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

test('imported HTML native social profile keeps intrinsic height and does not push following content below the viewport', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <head>
          <style>
            body { min-height: 100vh; margin: 0; }
            [data-rstk-native-id="perfil-principal"] { min-height: 52px; }
          </style>
        </head>
        <body>
          <main>
            <div class="social-slot" style="color:inherit;height:100vh!important;min-height:960px!important;max-height:1200px!important;aspect-ratio:1/1!important;flex:1 1 auto!important;margin:0 0 80vh!important" data-rstk-native-element="social-profile" data-rstk-native-id="perfil-principal" data-rstk-native-render="ristak" data-rstk-label="Perfil principal"></div>
            <h1 data-after-social-profile>Contenido siguiente visible</h1>
          </main>
        </body>
      </html>
    `, `HTML native social profile intrinsic height ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'social_profile',
      label: 'Perfil principal',
      content: 'Perfil de red social',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'perfil-principal',
        importedHtmlNativeType: 'social_profile',
        importedHtmlNativeRenderMode: 'ristak',
        platform: 'facebook',
        brandName: 'Ristak Oficial',
        brandAvatar: 'https://example.test/ristak-avatar.webp',
        followers: '40.3 mil',
        brandVerified: true
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /class="social-slot rstk-imported-native-slot rstk-imported-native-social-profile"/)
    assert.doesNotMatch(html, /rstk-imported-native-social_profile/)
    assert.match(html, /style="color:inherit"/)
    assert.doesNotMatch(html, /style="[^"]*(?:height|min-height|max-height|aspect-ratio|flex|margin):/)
    assert.match(html, /\.rstk-imported-native-slot\[data-rstk-native-mounted="true"\]\{display:block!important;height:auto!important;min-height:0!important;max-height:none!important;block-size:auto!important;min-block-size:0!important;max-block-size:none!important;flex:0 1 auto!important;/)
    assert.match(html, /\.rstk-imported-native-slot\{[^}]*min-height:var\(--rstk-vh100,100vh\)[^}]*\}/)
    assert.match(html, /data-after-social-profile[^>]*>Contenido siguiente visible<\/h1>/)
    assert.match(html, /Ristak Oficial/)
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
    assert.match(html, /filter\(form => !isCalendarBookingForm\(form\)\)/)
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
            <a class="button" data-rstk-button-action="next_page" data-rstk-button-actions='[{"id":"cta-final","action":"next_page"}]' href="?page=page-2">Continuar</a>
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
    assert.match(html, /target\.removeAttribute\('hidden'\)/)
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
    assert.match(html, /<a[^>]*data-rstk-video-action-target="cta-final"[^>]*data-rstk-video-action-hidden="true"/)
    assert.doesNotMatch(html, /Configura el video de Ristak/)

    const previewHtml = await renderPublicSiteHtml(currentSite, { pageId: 'page-1', trackingEnabled: false, preview: true })
    assert.match(previewHtml, /const PREVIEW_SAFE = true;/)
    assert.match(previewHtml, /data-rstk-video-preview="true"/)
    assert.match(previewHtml, /data-rstk-video-editor-preview="false"/)
    assert.match(previewHtml, /preload="auto"/)
    assert.match(previewHtml, /startPreviewLoop\(\)/)
    assert.match(previewHtml, /<a[^>]*data-rstk-video-action-target="cta-final"[^>]*data-rstk-video-action-hidden="true"/)

    const editorHtml = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true,
      importedNativePreviewMock: true
    })
    assert.match(editorHtml, /data-rstk-video-preview="false"/)
    assert.match(editorHtml, /data-rstk-video-editor-preview="true"/)
    assert.match(editorHtml, /preload="none"/)
    assert.match(editorHtml, /const editorPreview = video\.getAttribute\('data-rstk-video-editor-preview'\) === 'true'/)
    assert.match(editorHtml, /source && isHlsSource\(source\) && !editorPreview/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('native video gate keeps the real calendar inert, shows live remaining playback, and ignores seeks', async () => {
  let siteId = ''

  try {
    const site = await createImportedNativeSite(`
      <!doctype html>
      <html>
        <body>
          <section data-rstk-device-only="desktop">
            <div
              data-rstk-native-element="video"
              data-rstk-native-id="video-gate-desktop"
              data-rstk-video-gate-id="agenda-admision"
              data-rstk-video-gate-trigger="playback_seconds"
              data-rstk-video-gate-value="30"
            ></div>
          </section>
          <section data-rstk-device-only="mobile">
            <div
              data-rstk-native-element="video"
              data-rstk-native-id="video-gate-mobile"
              data-rstk-video-gate-id="agenda-admision"
              data-rstk-video-gate-trigger="playback_seconds"
              data-rstk-video-gate-value="30"
            ></div>
          </section>
          <section data-rstk-video-gate-shell="agenda-admision">
            <section
              data-rstk-native-element="calendar"
              data-rstk-native-id="agenda-real"
              data-rstk-native-render="custom"
              data-rstk-video-gate-content="agenda-admision"
              data-rstk-video-gate-locked-mode="blur"
              data-rstk-video-action-hidden="true"
              aria-hidden="true"
              hidden
            >
              <form data-rstk-calendar-book-form>
                <section data-rstk-calendar-flow-step="fecha" data-rstk-calendar-flow-kind="date">
                  <div data-rstk-calendar-days></div>
                </section>
                <section data-rstk-calendar-flow-step="horario" data-rstk-calendar-flow-kind="time" hidden>
                  <div data-rstk-calendar-slots></div>
                </section>
                <button type="submit">Agendar</button>
              </form>
            </section>
            <section data-rstk-video-gate-locked="agenda-admision">
              Faltan <strong data-rstk-video-gate-remaining="agenda-admision">30</strong> segundos.
            </section>
          </section>
          <aside data-rstk-video-gate-content="agenda-admision">Contenido legacy oculto</aside>
        </body>
      </html>
    `, `HTML native video gate ${Date.now()}`)
    siteId = site.id

    await createBlock(site.id, {
      blockType: 'video',
      label: 'Video gate desktop',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-gate-desktop',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-gate.mp4'
      }
    })
    await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Agenda gate',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-real',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'custom',
        calendarId: 'cal_gate',
        calendarSlug: 'agenda-gate',
        calendarName: 'Agenda gate'
      }
    })

    const currentSite = await getSite(site.id, { includeBlocks: true })
    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.equal((html.match(/data-rstk-video-gate-id="agenda-admision"/g) || []).length, 2)
    assert.match(html, /data-rstk-video-gate-shell="agenda-admision"[^>]*data-rstk-video-gate-state="locked"/)
    assert.match(html, /data-rstk-video-gate-content="agenda-admision"[^>]*data-rstk-video-gate-locked-mode="blur"[^>]*data-rstk-video-gate-state="locked"[^>]* inert[^>]*aria-hidden="true"/)
    assert.doesNotMatch(
      html,
      /data-rstk-video-gate-content="agenda-admision"[^>]*data-rstk-video-gate-locked-mode="blur"[^>]*\shidden(?:\s|=|>)/
    )
    assert.doesNotMatch(
      html,
      /data-rstk-video-gate-content="agenda-admision"[^>]*data-rstk-video-action-hidden/
    )
    assert.match(html, /<aside[^>]*data-rstk-video-gate-content="agenda-admision"[^>]*data-rstk-video-gate-state="locked"[^>]* hidden[^>]* inert[^>]*aria-hidden="true"/)
    assert.match(html, /data-rstk-video-gate-runtime/)
    assert.match(html, /window\.ristakSyncVideoGates/)
    assert.match(html, /const GATE_SOURCE_SELECTOR =/)
    assert.match(html, /gate\.progress = Math\.max\(0, \.\.\.Array\.from\(gate\.progressByVideo\.values\(\)\)\)/)
    assert.match(html, /filter:blur\(var\(--rstk-video-gate-blur,3px\)\)!important/)
    assert.match(html, /position:absolute!important;\s*inset:0!important;\s*z-index:2!important/)
    assert.match(html, /element\.setAttribute\('inert', ''\)/)
    assert.match(html, /element\.removeAttribute\('inert'\)/)
    assert.doesNotMatch(html, /ocultar-contador-30/)

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
    const gateRuntime = scripts.find(script => script.includes('ristakImportedVideoGateRuntimeLoaded'))
    const actionRuntime = scripts.find(script => script.includes('ristakVideoActionsRuntimeLoaded'))
    assert.ok(gateRuntime)
    assert.ok(actionRuntime)

    class FakeElement {
      constructor(attrs = {}) {
        this.attrs = new Map(Object.entries(attrs))
        this.hidden = this.attrs.has('hidden')
        this.textContent = ''
        this.styleValues = new Map()
        this.style = { setProperty: (name, value) => this.styleValues.set(name, String(value)) }
      }

      getAttribute(name) {
        return this.attrs.get(name) || ''
      }

      setAttribute(name, value) {
        this.attrs.set(name, String(value))
        if (name === 'hidden') this.hidden = true
      }

      removeAttribute(name) {
        this.attrs.delete(name)
        if (name === 'hidden') this.hidden = false
      }
    }

    const source = new FakeElement({
      'data-rstk-video-gate-id': 'agenda-admision',
      'data-rstk-video-gate-trigger': 'playback_seconds',
      'data-rstk-video-gate-value': '30'
    })
    const mobileSource = new FakeElement({
      'data-rstk-video-gate-id': 'agenda-admision',
      'data-rstk-video-gate-trigger': 'playback_seconds',
      'data-rstk-video-gate-value': '30'
    })
    const locked = new FakeElement({ 'data-rstk-video-gate-locked': 'agenda-admision' })
    const shell = new FakeElement({ 'data-rstk-video-gate-shell': 'agenda-admision' })
    const content = new FakeElement({
      'data-rstk-video-gate-content': 'agenda-admision',
      'data-rstk-video-gate-locked-mode': 'blur',
      inert: '',
      'aria-hidden': 'true'
    })
    const legacyContent = new FakeElement({
      'data-rstk-video-gate-content': 'agenda-admision',
      hidden: '',
      inert: '',
      'aria-hidden': 'true'
    })
    const remaining = new FakeElement({ 'data-rstk-video-gate-remaining': 'agenda-admision' })

    class FakeVideo extends FakeElement {
      constructor(gateSource) {
        super()
        this.gateSource = gateSource
        this.dataset = {}
        this.autoplay = false
        this.paused = false
        this.ended = false
        this.currentTime = 0
        this.duration = 120
        this.playbackRate = 1
        this.listeners = new Map()
      }

      closest(selector) {
        return selector.includes('video-gate-id') ? this.gateSource : null
      }

      addEventListener(name, listener) {
        const listeners = this.listeners.get(name) || []
        listeners.push(listener)
        this.listeners.set(name, listeners)
      }

      dispatch(name) {
        for (const listener of this.listeners.get(name) || []) listener({ type: name })
      }
    }

    const video = new FakeVideo(source)
    const mobileVideo = new FakeVideo(mobileSource)
    const sourceSelector = '[data-rstk-video-gate-id],[data-ristak-video-gate-id],[data-ristack-video-gate-id]'
    const gateVideoSelector = '[data-rstk-video-gate-id] video,[data-ristak-video-gate-id] video,[data-ristack-video-gate-id] video'
    const document = {
      documentElement: {},
      cookie: '',
      querySelectorAll: selector => {
        if (selector === sourceSelector) return [source, mobileSource]
        if (selector === gateVideoSelector) return [video, mobileVideo]
        if (selector === 'video[data-rstk-video-actions]') return []
        if (selector.includes('video-gate-shell')) return [shell]
        if (selector.includes('video-gate-locked')) return [locked]
        if (selector.includes('video-gate-content')) return [content, legacyContent]
        if (selector.includes('video-gate-remaining-time')) return []
        if (selector.includes('video-gate-remaining')) return [remaining]
        return []
      },
      querySelector: () => null,
      getElementById: () => null
    }
    let nowMs = 0
    let nextFrameId = 0
    const window = {
      CSS: { escape: value => String(value) },
      performance: { now: () => nowMs },
      requestAnimationFrame: () => {
        nextFrameId += 1
        return nextFrameId
      },
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {}
    }
    class MutationObserver {
      observe() {}
    }

    const context = { window, document, MutationObserver }
    vm.runInNewContext(gateRuntime, context)
    vm.runInNewContext(actionRuntime, context)

    assert.equal(content.hidden, false)
    assert.equal(content.attrs.has('inert'), true)
    assert.equal(content.attrs.has('aria-hidden'), true)
    assert.equal(legacyContent.hidden, true)
    assert.equal(legacyContent.attrs.has('inert'), true)
    assert.equal(locked.hidden, false)
    assert.equal(remaining.textContent, '30')

    video.dispatch('play')
    nowMs = 10_000
    video.currentTime = 10
    video.dispatch('timeupdate')
    assert.equal(remaining.textContent, '20')
    video.dispatch('pause')
    assert.equal(remaining.textContent, '20')
    video.dispatch('play')

    mobileVideo.dispatch('play')
    nowMs += 10_000
    mobileVideo.currentTime = 10
    mobileVideo.dispatch('timeupdate')
    assert.equal(remaining.textContent, '20')

    video.dispatch('seeking')
    video.currentTime = 29
    video.dispatch('seeked')
    assert.equal(remaining.textContent, '20')
    assert.equal(content.hidden, false)
    assert.equal(content.attrs.has('inert'), true)
    assert.equal(legacyContent.hidden, true)

    for (let step = 1; step <= 4; step += 1) {
      nowMs += 5_000
      video.currentTime += 5
      video.dispatch('timeupdate')
    }

    assert.equal(remaining.textContent, '0')
    assert.equal(content.hidden, false)
    assert.equal(content.attrs.has('inert'), false)
    assert.equal(content.attrs.has('aria-hidden'), false)
    assert.equal(legacyContent.hidden, false)
    assert.equal(legacyContent.attrs.has('inert'), false)
    assert.equal(content.getAttribute('data-rstk-video-gate-state'), 'unlocked')
    assert.equal(shell.getAttribute('data-rstk-video-gate-state'), 'unlocked')
    assert.equal(locked.hidden, true)
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

test('declarative HTML video player settings reconcile without overwriting manual customization', async () => {
  let siteId = ''
  const settingsAttribute = settings => `data-rstk-video-settings='${JSON.stringify(settings)}'`
  const renderPage = (attribute = '') => `
    <!doctype html>
    <html>
      <body>
        <main>
          <div
            data-rstk-native-element="video"
            data-rstk-native-id="video-principal"
            data-rstk-label="Video principal"
            ${attribute}
          ></div>
        </main>
      </body>
    </html>
  `

  const initialDeclaration = {
    videoControlsMode: 'clean',
    videoOverlayPlay: true,
    videoControlBar: true,
    videoControlProgress: false,
    videoControlVolume: false,
    videoPlayerRadius: 18,
    videoPlayShape: 'round',
    videoPlaySize: 96,
    videoPlayColor: '#f8fafc',
    responsive: {
      tablet: { mediaWidth: 72, mediaAlign: 'center' },
      mobile: { mediaWidth: 100, mediaAlign: 'center' }
    }
  }

  try {
    const site = await createImportedNativeSite(
      renderPage(settingsAttribute(initialDeclaration)),
      `HTML declarative video player ${Date.now()}`
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
        mediaUrl: 'https://cdn.example.test/declarative-player.mp4'
      }
    })

    let currentSite = await getSite(site.id, { includeBlocks: true })
    let videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.ok(videoBlock)
    assert.equal(videoBlock.settings.videoControlProgress, false)
    assert.equal(videoBlock.settings.videoControlVolume, false)
    assert.equal(videoBlock.settings.videoPlayShape, 'round')
    assert.equal(videoBlock.settings.responsive.tablet.mediaWidth, 72)
    assert.deepEqual(
      videoBlock.settings.importedHtmlVideoPlayerKeys,
      Object.keys(initialDeclaration).sort((left, right) => left.localeCompare(right))
    )
    assert.equal(typeof videoBlock.settings.importedHtmlVideoPlayerSignature, 'string')

    await updateBlock(site.id, videoBlock.id, {
      settings: {
        ...videoBlock.settings,
        videoControlVolume: true,
        videoPlaySize: 110,
        responsive: {
          ...videoBlock.settings.responsive,
          mobile: { mediaWidth: 86, mediaAlign: 'right' }
        }
      }
    })

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage(settingsAttribute(initialDeclaration)) }]
    })
    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoControlVolume, true)
    assert.equal(videoBlock.settings.videoPlaySize, 110)
    assert.equal(videoBlock.settings.responsive.mobile.mediaWidth, 86)
    assert.equal(videoBlock.settings.responsive.mobile.mediaAlign, 'right')

    const updatedDeclaration = {
      ...initialDeclaration,
      videoOverlayPlay: false,
      videoControlProgress: null,
      videoPlayerRadius: 30,
      responsive: {
        tablet: { mediaWidth: 68, mediaAlign: 'left' }
      }
    }
    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage(settingsAttribute(updatedDeclaration)) }]
    })
    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoOverlayPlay, false)
    assert.equal(videoBlock.settings.videoPlayerRadius, 30)
    assert.equal(Object.prototype.hasOwnProperty.call(videoBlock.settings, 'videoControlProgress'), false)
    assert.equal(videoBlock.settings.videoControlVolume, true)
    assert.equal(videoBlock.settings.videoPlaySize, 110)
    assert.equal(videoBlock.settings.responsive.tablet.mediaWidth, 68)
    assert.equal(videoBlock.settings.responsive.tablet.mediaAlign, 'left')
    assert.equal(videoBlock.settings.responsive.mobile.mediaWidth, 86)
    assert.equal(videoBlock.settings.responsive.mobile.mediaAlign, 'right')
    assert.equal(videoBlock.settings.importedHtmlVideoPlayerKeys.includes('videoControlProgress'), false)

    await updateImportedSiteCodeFiles(site.id, {
      files: [{ path: '', content: renderPage() }]
    })
    currentSite = await getSite(site.id, { includeBlocks: true })
    videoBlock = currentSite.blocks.find(block => block.blockType === 'video')
    assert.equal(videoBlock.settings.videoOverlayPlay, false)
    assert.equal(videoBlock.settings.videoPlayerRadius, 30)
    assert.equal(videoBlock.settings.videoControlVolume, true)

    const html = await renderPublicSiteHtml(currentSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: false
    })
    assert.doesNotMatch(html, /<button[^>]+data-rstk-video-overlay/)
    assert.match(html, /<div class="rstk-video-progress" data-rstk-video-progress-track/)
    assert.match(html, /--rstk-video-radius:30px/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
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
