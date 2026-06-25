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
  assert.doesNotMatch(html, /data-rstk-form-action-area/)
  assert.doesNotMatch(html, /class="rstk-actions"[^>]*data-rstk-video-action-hidden/)
})

test('editor preview never hides the submit button (rule only applies to the published page)', async () => {
  const html = await renderPublicSiteHtml(revealFormActionSite(REVEAL_RULES), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-submit/)
  // No initial hide and no runtime in the editor preview.
  assert.doesNotMatch(html, /data-rstk-form-action-area/)
  assert.doesNotMatch(html, /ristakVideoActionsRuntimeLoaded/)
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
