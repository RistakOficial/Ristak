import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPreviewSiteDraft, renderPublicSiteHtml } from '../src/services/sitesService.js'

const baseSite = {
  id: 'site_preview_draft',
  name: 'Preview draft',
  title: 'Titulo guardado',
  description: 'Descripcion guardada',
  slug: 'preview-draft',
  siteType: 'landing_page',
  status: 'draft',
  theme: {
    template: 'ristak',
    pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
  },
  blocks: [
    {
      id: 'saved-title',
      siteId: 'site_preview_draft',
      blockType: 'title',
      label: 'Titulo',
      content: 'Titulo viejo guardado',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      settings: { pageId: 'page-1' },
      createdAt: '',
      updatedAt: ''
    }
  ]
}

test('preview draft renders current editor blocks and settings instead of saved blocks', async () => {
  const draftSite = {
    ...baseSite,
    title: 'Titulo vivo del editor',
    description: '',
    theme: {
      ...baseSite.theme,
      buttonRadius: 10
    },
    blocks: [
      {
        id: 'draft-button',
        siteId: 'wrong-site',
        blockType: 'button',
        label: 'Boton',
        content: 'Comprar ahora',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 2,
        settings: {
          pageId: 'page-1',
          buttonAlign: 'full',
          buttonBg: '#111827',
          buttonTextColor: '#ffffff',
          buttonHeight: 70,
          buttonFontSize: 22,
          buttonRadius: 8
        }
      },
      {
        id: 'draft-title',
        siteId: 'wrong-site',
        blockType: 'title',
        label: 'Titulo',
        content: 'Titulo vivo del editor',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 1,
        settings: {
          pageId: 'page-1',
          blockText: '#f43f5e',
          fontSize: 42,
          textAlign: 'center'
        }
      },
      {
        id: 'unsafe-block',
        siteId: 'wrong-site',
        blockType: 'script',
        label: 'No valido',
        content: 'No debe renderizar',
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      }
    ]
  }

  const previewSite = await buildPreviewSiteDraft(baseSite, draftSite)

  assert.ok(previewSite)
  assert.equal(previewSite.title, 'Titulo vivo del editor')
  assert.equal(previewSite.description, '')
  assert.deepEqual(previewSite.blocks.map(block => block.id), ['draft-title', 'draft-button'])
  assert.deepEqual(previewSite.blocks.map(block => block.siteId), [baseSite.id, baseSite.id])

  const html = await renderPublicSiteHtml(previewSite, {
    pageId: 'page-1',
    preview: true,
    trackingEnabled: false
  })

  assert.match(html, /Titulo vivo del editor/)
  assert.match(html, /Comprar ahora/)
  assert.match(html, /--rstk-block-size:42px/)
  assert.match(html, /--rstk-block-align:center/)
  assert.match(html, /--rstk-button-height:70px/)
  assert.match(html, /--rstk-button-size:22px/)
  assert.match(html, /--rstk-block-button-radius:8px/)
  assert.doesNotMatch(html, /Titulo viejo guardado/)
  assert.doesNotMatch(html, /No debe renderizar/)
})

test('preview draft is ignored when it does not belong to the requested site', async () => {
  const previewSite = await buildPreviewSiteDraft(baseSite, {
    ...baseSite,
    id: 'other-site',
    blocks: []
  })

  assert.equal(previewSite, null)
})
