import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

const baseSite = (settings) => ({
  id: 'site_video_player',
  name: 'Landing con video',
  title: 'Landing con video',
  description: '',
  slug: 'landing-video',
  siteType: 'landing_page',
  status: 'published',
  theme: {
    template: 'ristak',
    pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
  },
  blocks: [
    {
      id: 'video-block',
      siteId: 'site_video_player',
      blockType: 'video',
      label: 'Video',
      content: '',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.com/video.mp4',
        ...settings
      },
      createdAt: '',
      updatedAt: ''
    }
  ]
})

test('video player clean mode renders Wistia-style overlay controls', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoSoundHint: true,
    videoPlaySize: 82
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /rstk-video-custom-controls/)
  assert.match(html, /<button type="button" class="rstk-video-overlay" data-rstk-video-overlay/)
  assert.match(html, /<span class="rstk-video-sound">/)
  assert.match(html, /--rstk-video-play-size:82px/)
})

test('video player none mode removes overlay and audio prompt', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'none',
    videoSoundHint: true
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /rstk-video-no-controls/)
  assert.doesNotMatch(html, /<button type="button" class="rstk-video-overlay" data-rstk-video-overlay/)
  assert.doesNotMatch(html, /<span class="rstk-video-sound">/)
})
