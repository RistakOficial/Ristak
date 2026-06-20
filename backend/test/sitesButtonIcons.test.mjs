import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

test('landing buttons render configured icons without changing plain button markup', async () => {
  const site = {
    id: 'site_button_icon_render',
    name: 'Landing con icono',
    title: 'Landing con icono',
    description: '',
    slug: 'landing-icono',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'button-icon',
        siteId: 'site_button_icon_render',
        blockType: 'button',
        label: 'Boton',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          buttonText: 'Reservar ahora',
          buttonIcon: 'arrowRight',
          buttonIconSide: 'right',
          buttonPaddingY: 18
        },
        createdAt: '',
        updatedAt: ''
      },
      {
        id: 'button-plain',
        siteId: 'site_button_icon_render',
        blockType: 'button',
        label: 'Boton sencillo',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 1,
        settings: {
          pageId: 'page-1',
          buttonText: 'Continuar'
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

  assert.match(html, /<span class="rstk-button-content rstk-button-icon-right">/)
  assert.match(html, /<span class="rstk-button-label">Reservar ahora<\/span>/)
  assert.match(html, /<span class="rstk-button-icon" aria-hidden="true"><svg/)
  assert.match(html, /rstkButtonPaddingOverride/)
  assert.match(html, /--rstk-button-pad-y:18px/)
  assert.match(html, /<span class="rstk-button-label">Continuar<\/span><\/a>/)
  assert.doesNotMatch(html, /<span class="rstk-button-content rstk-button-icon-right"><span class="rstk-button-text-stack"><span class="rstk-button-label">Continuar/)
})
