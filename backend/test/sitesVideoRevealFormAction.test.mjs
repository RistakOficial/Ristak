import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

const revealFormActionSite = (videoActions) => ({
  id: 'site_reveal_form_action',
  name: 'VSL form',
  title: 'VSL form',
  description: '',
  slug: 'vsl-reveal-form-action',
  siteType: 'standard_form',
  status: 'published',
  theme: {
    template: 'ristak',
    pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
  },
  blocks: [
    {
      id: 'video-1',
      siteId: 'site_reveal_form_action',
      blockType: 'video',
      label: 'Video',
      content: '',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.com/vsl.mp4',
        ...(videoActions ? { videoActions } : {})
      },
      createdAt: '',
      updatedAt: ''
    },
    {
      id: 'email-1',
      siteId: 'site_reveal_form_action',
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'correo@example.com',
      required: true,
      options: [],
      sortOrder: 1,
      settings: { pageId: 'page-1', internalName: 'email', validation: 'email' },
      createdAt: '',
      updatedAt: ''
    }
  ]
})

const REVEAL_RULES = [{ id: 'reveal-1', action: 'reveal_form_action', timeSeconds: 30 }]

const embeddedRevealLandingSite = () => ({
  id: 'landing_embedded_reveal_form_action',
  name: 'Landing con formulario y video',
  title: 'Landing con formulario y video',
  description: '',
  slug: 'landing-embedded-reveal-form-action',
  siteType: 'landing_page',
  status: 'published',
  theme: {
    template: 'ristak',
    pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
  },
  blocks: [
    {
      id: 'form-embed-1',
      siteId: 'landing_embedded_reveal_form_action',
      blockType: 'form_embed',
      label: 'Formulario',
      content: '',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        embeddedPages: [{ id: 'form-page-1', title: 'Formulario', sortOrder: 0 }],
        embeddedBlocks: [
          {
            id: 'embedded-video-1',
            blockType: 'video',
            label: 'Video',
            content: '',
            required: false,
            options: [],
            sortOrder: 0,
            settings: {
              pageId: 'form-page-1',
              mediaUrl: 'https://cdn.example.com/vsl.mp4',
              videoActions: REVEAL_RULES
            }
          },
          {
            id: 'embedded-qualification-1',
            blockType: 'radio',
            label: '¿Calificas?',
            content: '',
            required: true,
            options: [
              { id: 'yes', label: 'Sí', value: 'Sí', action: 'continue' },
              { id: 'no', label: 'No', value: 'No', action: 'disqualify_after_submit' }
            ],
            sortOrder: 1,
            settings: { pageId: 'form-page-1' }
          },
          {
            id: 'embedded-disqualified-title',
            blockType: 'title',
            label: 'Título',
            content: 'Gracias por responder.',
            required: false,
            options: [],
            sortOrder: 2,
            settings: { pageId: 'page-3' }
          }
        ]
      },
      createdAt: '',
      updatedAt: ''
    }
  ]
})

test('standard form reveal_form_action hides the submit button until the video reaches the point', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite(REVEAL_RULES), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  // The submit button exists...
  assert.match(html, /data-submit/)
  // ...and its actions area is flagged + hidden up front (no flash).
  assert.match(html, /class="rstk-actions" data-rstk-form-action-area data-rstk-video-action-hidden="true" aria-hidden="true"/)
  // The video carries the action so the runtime can drive the reveal.
  assert.match(html, /data-rstk-video-actions=/)
  assert.match(html, /reveal_form_action/)
  // The runtime that toggles visibility is injected on the published page.
  assert.match(html, /ristakVideoActionsRuntimeLoaded/)
  assert.match(html, /data-rstk-form-action-area/)
})

test('standard form without the rule keeps the submit button visible', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite(null), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  assert.match(html, /data-submit/)
  assert.doesNotMatch(html, /class="rstk-actions"[^>]*data-rstk-form-action-area/)
  assert.doesNotMatch(html, /class="rstk-actions"[^>]*data-rstk-video-action-hidden/)
})

// Actualizado por la paridad preview/publicado (pipeline #4/#8): el preview ya
// NO diverge del sitio publicado — la regla de revelado marca el área de acciones
// y el runtime de acciones de video también se inyecta en preview.
test('preview mirrors the published page: reveal rule marks the action area and injects the runtime', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite(REVEAL_RULES), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-submit/)
  assert.match(html, /class="rstk-actions" data-rstk-form-action-area data-rstk-video-action-hidden="true" aria-hidden="true"/)
  assert.match(html, /ristakVideoActionsRuntimeLoaded/)
})

test('reveal_form_action persists the unlock per visitor with a TTL', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite([
    { id: 'reveal-1', action: 'reveal_form_action', timeSeconds: 30, repeatMode: 'remember_visitor', storageValue: 45, storageUnit: 'days' }
  ]), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  // The rule carries its repeat mode and a server-computed TTL (45 days).
  assert.match(html, /&quot;repeatMode&quot;:&quot;remember_visitor&quot;/)
  assert.match(html, /&quot;storageTtlSeconds&quot;:3888000/)
  // The runtime knows how to read/remember the unlock across visits.
  assert.match(html, /revealAlreadyStored/)
  assert.match(html, /rememberReveal/)
  assert.match(html, /video-reveal-form-action/)
})

test('reveal_form_action defaults to restarting every visit (no persistence)', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite(REVEAL_RULES), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  assert.match(html, /&quot;repeatMode&quot;:&quot;every_visit&quot;/)
})

test('embedded terminal results cannot be reopened by a delayed video reveal action', async () => {
  const html = await renderPublicSiteHtml(embeddedRevealLandingSite(), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  assert.match(html, /class="rstk-actions rstk-embed-actions" data-rstk-form-action-area/)
  assert.match(html, /data-embedded-form-result="disqualified" hidden/)
  assert.match(html, /Gracias por responder\./)
  // La pantalla final declara un estado terminal antes de pausar el video.
  assert.match(html, /host\.setAttribute\('data-rstk-form-terminal-result', status\)/)
  // El runtime del video respeta ese estado incluso si la regla ya estaba
  // desbloqueada/persistida y recibe un último evento pause/timeupdate.
  assert.match(html, /const terminalResultHost = area\.closest\('\[data-rstk-form-terminal-result\]'\)/)
  assert.match(html, /if \(terminalResultHost\) \{\s*setTargetHidden\(area, true\);\s*return;/)
  // La hoja pública conserva el bloqueo aunque otro callback quite `hidden`.
  assert.match(html, /\[data-rstk-form-terminal-result\] \[data-rstk-form-action-area\]\{display:none!important\}/)
})
