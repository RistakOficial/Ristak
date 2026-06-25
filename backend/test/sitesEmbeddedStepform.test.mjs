import test from 'node:test'
import assert from 'node:assert/strict'

import { createBlock, createSite, deleteSite, renderPublicSiteHtml } from '../src/services/sitesService.js'

test('landing form embeds render multiple form pages as an inline stepform', async () => {
  const site = {
    id: 'site_embedded_stepform',
    name: 'Landing con formulario',
    title: 'Landing con formulario',
    description: '',
    slug: 'landing-formulario',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'embed-form',
        siteId: 'site_embedded_stepform',
        blockType: 'form_embed',
        label: 'Formulario',
        content: 'Formulario',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          embeddedPages: [
            { id: 'step-1', title: 'Paso 1', sortOrder: 0, buttonText: 'Siguiente pregunta' },
            { id: 'step-2', title: 'Paso 2', sortOrder: 1, buttonText: 'Enviar solicitud', buttonSubtitle: 'Finalizar' }
          ],
          embeddedBlocks: [
            {
              id: 'content-title',
              siteId: 'site_embedded_stepform',
              blockType: 'title',
              label: 'Título',
              content: 'Título interno del formulario',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 0,
              settings: { pageId: 'step-1' }
            },
            {
              id: 'field-name',
              siteId: 'site_embedded_stepform',
              blockType: 'short_text',
              label: 'Nombre',
              content: '',
              placeholder: 'Tu nombre',
              required: true,
              options: [],
              sortOrder: 1,
              settings: { pageId: 'step-1' }
            },
            {
              id: 'field-email',
              siteId: 'site_embedded_stepform',
              blockType: 'email',
              label: 'Correo',
              content: '',
              placeholder: 'tu@email.com',
              required: true,
              options: [],
              sortOrder: 2,
              settings: { pageId: 'step-2' }
            },
            {
              id: 'final-page-copy',
              siteId: 'site_embedded_stepform',
              blockType: 'text',
              label: 'Texto',
              content: 'Texto de página final que no debe aparecer',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 3,
              settings: { pageId: 'page-2' }
            }
          ]
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-embedded-form-pages/)
  assert.match(html, /--rstk-page-border-width:20px/)
  assert.match(html, /\.rstk-embedded-form-source-frame\{[^}]*margin:0;padding:0/)
  assert.match(html, /data-embedded-page-content="step-1"/)
  assert.match(html, /data-embedded-page-content="step-2" hidden/)
  assert.match(html, /data-embedded-next/)
  assert.match(html, /<button type="button" data-embedded-next>Siguiente pregunta<\/button>/)
  assert.match(html, /data-embedded-page-content="step-2" hidden data-next-label="Enviar solicitud" data-submit-label="Enviar solicitud" data-submit-subtitle="Finalizar"/)
  assert.match(html, /<button type="submit" data-submit hidden><span class="rstk-button-label">Enviar solicitud<\/span><span class="rstk-button-subtitle">Finalizar<\/span><\/button>/)
  assert.match(html, /data-embedded-back hidden/)
  assert.match(html, /data-submit hidden/)
  assert.match(html, /Título interno del formulario/)
  assert.match(html, /data-block-id="field-name" data-page-id="step-1"/)
  assert.match(html, /data-block-id="field-email" data-page-id="step-2"/)
  assert.doesNotMatch(html, /Texto de página final que no debe aparecer/)
  assert.doesNotMatch(html, /<h2>Formulario<\/h2>/)
  assert.match(html, /getEmbeddedPageFields/)
  assert.match(html, /embeddedForms\.forEach\(renderEmbeddedForm\)/)
  assert.match(html, /state\.index = 0;/)
})

test('standard form content-only pages still render navigation actions', async () => {
  const site = {
    id: 'site_standard_content_steps',
    name: 'Formulario con paginas de contenido',
    title: 'Formulario con paginas de contenido',
    description: '',
    slug: 'formulario-contenido',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      template: 'compact',
      pages: [
        { id: 'page-1', title: 'Intro', sortOrder: 0, buttonText: 'Ver siguiente parte' },
        { id: 'page-content', title: 'Video', sortOrder: 1, buttonText: 'Enviar mi solicitud' }
      ]
    },
    blocks: [
      {
        id: 'intro-title',
        siteId: 'site_standard_content_steps',
        blockType: 'title',
        label: 'Titulo',
        content: 'Antes de empezar',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      },
      {
        id: 'intro-copy',
        siteId: 'site_standard_content_steps',
        blockType: 'text',
        label: 'Texto',
        content: 'Esta pagina no tiene campos.',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 1,
        settings: { pageId: 'page-1' }
      },
      {
        id: 'content-video',
        siteId: 'site_standard_content_steps',
        blockType: 'video',
        label: 'Video',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 2,
        settings: { pageId: 'page-content', mediaUrl: 'https://example.test/video.mp4' }
      },
      {
        id: 'content-copy',
        siteId: 'site_standard_content_steps',
        blockType: 'text',
        label: 'Texto',
        content: 'Ultima pagina antes de enviar.',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 3,
        settings: { pageId: 'page-content' }
      }
    ]
  }

  const firstPageHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(firstPageHtml, /Antes de empezar/)
  assert.match(firstPageHtml, /<button type="button" data-form-next>Ver siguiente parte<\/button>/)
  assert.match(firstPageHtml, /<button type="submit" hidden data-submit>/)

  const lastContentPageHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-content',
    trackingEnabled: false,
    preview: true
  })

  assert.match(lastContentPageHtml, /Ultima pagina antes de enviar/)
  assert.doesNotMatch(lastContentPageHtml, /<button type="button" data-form-next>/)
  assert.doesNotMatch(lastContentPageHtml, /<button type="submit" hidden data-submit>/)
  assert.match(lastContentPageHtml, /<button type="submit"\s+data-submit><span class="rstk-button-label">Enviar mi solicitud<\/span><\/button>/)
})

test('landing form embeds proxy linked form source instead of stale embedded copies', async () => {
  let formSite

  try {
    formSite = await createSite({
      name: 'Formulario fuente proxy',
      slug: `form-source-proxy-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        template: 'facebook',
        brandName: 'Formulario 01',
        brandSubtitle: 'Patrocinado',
        backgroundColor: '#112233',
        pages: [
          { id: 'source-step-1', title: 'Fuente 1', sortOrder: 0, buttonText: 'Siguiente desde fuente' },
          { id: 'source-step-2', title: 'Fuente 2', sortOrder: 1, buttonText: 'Enviar fuente' }
        ]
      }
    })

    await createBlock(formSite.id, {
      blockType: 'title',
      label: 'Título',
      content: 'Deja tus datos y seguimos por mensaje',
      required: false,
      settings: { pageId: 'source-step-1' }
    })
    await createBlock(formSite.id, {
      blockType: 'text',
      label: 'Texto',
      content: 'Completa este formulario corto y te contactamos con el siguiente paso.',
      required: false,
      settings: { pageId: 'source-step-1' }
    })
    await createBlock(formSite.id, {
      blockType: 'short_text',
      label: 'Campo real fuente',
      placeholder: 'Respuesta real',
      required: true,
      settings: { pageId: 'source-step-1' }
    })
    formSite = await createBlock(formSite.id, {
      blockType: 'email',
      label: 'Correo fuente',
      placeholder: 'real@example.test',
      required: true,
      settings: { pageId: 'source-step-2' }
    })

    const landing = {
      id: 'landing_proxy_embed',
      name: 'Landing proxy',
      title: 'Landing proxy',
      description: '',
      slug: 'landing-proxy',
      siteType: 'landing_page',
      status: 'published',
      theme: {
        template: 'ristak',
        pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
      },
      blocks: [
        {
          id: 'embed-form-proxy',
          siteId: 'landing_proxy_embed',
          blockType: 'form_embed',
          label: 'Formulario',
          content: '',
          placeholder: '',
          required: false,
          options: [],
          sortOrder: 0,
          settings: {
            pageId: 'page-1',
            formSiteId: formSite.id,
            embeddedPages: [{ id: 'stale-step', title: 'Viejo', sortOrder: 0, buttonText: 'Boton viejo' }],
            embeddedBlocks: [
              {
                id: 'stale-field',
                siteId: 'landing_proxy_embed',
                blockType: 'short_text',
                label: 'Campo viejo',
                content: '',
                placeholder: 'Viejo',
                required: false,
                options: [],
                sortOrder: 0,
                settings: { pageId: 'stale-step' }
              }
            ]
          },
          createdAt: '',
          updatedAt: ''
        }
      ]
    }

    const html = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /Campo real fuente/)
    assert.match(html, /Correo fuente/)
    assert.match(html, /<button type="button" data-embedded-next>Siguiente desde fuente<\/button>/)
    assert.match(html, /data-submit-label="Enviar fuente"/)
    assert.match(html, /rstk-embedded-form-source-frame/)
    assert.match(html, /rstk-embedded-form-source-chrome/)
    assert.match(html, /rstk-social-platform-facebook/)
    assert.match(html, /Formulario 01/)
    assert.match(html, /Patrocinado/)
    assert.match(html, /Deja tus datos y seguimos por mensaje/)
    assert.match(html, /Completa este formulario corto/)
    assert.match(html, /rstk-kind-form/)
    assert.match(html, /--rstk-page-bg:#112233;/)
    assert.match(html, /--rstk-block-bg:#112233;/)
    assert.doesNotMatch(html, /Campo viejo/)
    assert.doesNotMatch(html, /Boton viejo/)
    assert.doesNotMatch(html, /data-embedded-page-content="stale-step"/)
  } finally {
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
  }
})

test('landing form embeds preserve explicit white source backgrounds', async () => {
  let formSite
  try {
    formSite = await createSite({
      name: 'Formulario blanco',
      siteType: 'standard_form',
      theme: {
        template: 'facebook_lead',
        backgroundColor: '#ffffff',
        pageRadius: 24,
        pageMaxWidth: 520,
        pagePadding: 22
      },
      status: 'draft'
    })
    await createBlock(formSite.id, {
      blockType: 'title',
      label: 'Titulo',
      content: 'Formulario blanco',
      settings: { pageId: 'page-1' },
      sortOrder: 0
    })
    await createBlock(formSite.id, {
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'correo@example.test',
      required: true,
      settings: { pageId: 'page-1' },
      sortOrder: 1
    })

    const landing = {
      id: 'landing_white_embed',
      name: 'Landing blanco',
      siteType: 'landing_page',
      status: 'draft',
      theme: {
        template: 'ristak'
      },
      blocks: [
      {
        id: 'landing_white_embed_block',
        siteId: 'landing_white_embed',
        blockType: 'form_embed',
        label: 'Formulario blanco',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          formSiteId: formSite.id
        },
        createdAt: '',
        updatedAt: ''
      }
      ]
    }

    const html = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /rstk-embedded-form-source-frame/)
    assert.match(html, /--rstk-page-bg:#ffffff;/)
    assert.match(html, /--rstk-block-bg:#ffffff;/)
  } finally {
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
  }
})

test('landing form embeds inherit source completion rules or target a specific page', async () => {
  const embeddedBlocks = [
    {
      id: 'completion-email',
      siteId: 'landing_completion_embed',
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'correo@example.test',
      required: true,
      options: [],
      sortOrder: 0,
      settings: { pageId: 'form-step' }
    }
  ]
  const baseLanding = {
    id: 'landing_completion_embed',
    name: 'Landing completion',
    title: 'Landing completion',
    description: '',
    slug: 'landing-completion',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    },
    blocks: [
      {
        id: 'embed-form-completion',
        siteId: 'landing_completion_embed',
        blockType: 'form_embed',
        label: 'Formulario',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          completionAction: 'form_default',
          embeddedTheme: {
            template: 'ristak',
            formCompletionAction: 'redirect_qualified',
            formQualifiedRedirectUrl: 'https://example.test/califica',
            formDisqualifiedCompletionAction: 'redirect_url',
            formDisqualifiedRedirectUrl: 'https://example.test/no-califica'
          },
          embeddedPages: [{ id: 'form-step', title: 'Formulario', sortOrder: 0, buttonText: 'Enviar' }],
          embeddedBlocks
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }

  const inheritedHtml = await renderPublicSiteHtml(baseLanding, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(inheritedHtml, /const completionAction = "redirect_qualified";/)
  assert.match(inheritedHtml, /const qualifiedRedirectUrl = "https:\/\/example\.test\/califica";/)
  assert.match(inheritedHtml, /const disqualifiedCompletionAction = "redirect_url";/)
  assert.match(inheritedHtml, /const disqualifiedRedirectUrl = "https:\/\/example\.test\/no-califica";/)
  // "Usar reglas del formulario" (form_default): el redirect propio del formulario manda.
  assert.match(inheritedHtml, /const completionUsesFormRules = true;/)
  // El corto-circuito del redirect del formulario queda condicionado a esa bandera.
  assert.match(inheritedHtml, /if \(submission\.redirectUrl && completionUsesFormRules\)/)

  const specificPageHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'specific_page',
        completionPageId: 'page-2'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(specificPageHtml, /const completionAction = "specific_page";/)
  assert.match(specificPageHtml, /const completionTargetPageUrl = "\?page=page-2";/)
  // Acción del editor de sitios (no form_default): el redirect del formulario NO debe mandar.
  assert.match(specificPageHtml, /const completionUsesFormRules = false;/)

  const unconditionalRedirectHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'redirect',
        completionRedirectUrl: 'https://example.test/siempre'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(unconditionalRedirectHtml, /const completionAction = "redirect";/)
  assert.match(unconditionalRedirectHtml, /const qualifiedRedirectUrl = "https:\/\/example\.test\/siempre";/)
  // Unconditional redirect branch is present in the decision script.
  assert.match(unconditionalRedirectHtml, /completionAction === 'redirect' && qualifiedRedirectUrl/)
  // Redirigir a URL (no form_default): el redirect del formulario NO debe mandar.
  assert.match(unconditionalRedirectHtml, /const completionUsesFormRules = false;/)

  const specificPageIfQualifiedHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'specific_page_if_qualified',
        completionPageId: 'page-2'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(specificPageIfQualifiedHtml, /const completionAction = "specific_page_if_qualified";/)
  assert.match(specificPageIfQualifiedHtml, /const completionTargetPageUrl = "\?page=page-2";/)
  // Conditional specific-page branch is present in the decision script.
  assert.match(specificPageIfQualifiedHtml, /completionAction === 'specific_page_if_qualified'/)
  // Variante "si no descalifica" (no form_default): el redirect del formulario NO debe mandar.
  assert.match(specificPageIfQualifiedHtml, /const completionUsesFormRules = false;/)
})

test('standalone standard form keeps honoring its own result redirect', async () => {
  // Fuera de un embed de sitio (formulario/embudo standalone) el redirect propio
  // del formulario (página de calificación/descalificación) siempre debe mandar.
  const site = {
    id: 'site_standalone_result_redirect',
    name: 'Formulario standalone',
    title: 'Formulario standalone',
    description: '',
    slug: 'formulario-standalone',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      template: 'compact',
      pages: [{ id: 'page-1', title: 'Formulario', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'standalone-email',
        siteId: 'site_standalone_result_redirect',
        blockType: 'email',
        label: 'Correo',
        content: '',
        placeholder: 'correo@example.test',
        required: true,
        options: [],
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /const completionUsesFormRules = true;/)
  assert.match(html, /if \(submission\.redirectUrl && completionUsesFormRules\)/)
})
