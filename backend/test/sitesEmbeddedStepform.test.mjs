import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

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
