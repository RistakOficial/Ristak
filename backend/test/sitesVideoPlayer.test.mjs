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
    videoPlayerBackground: '#111827',
    videoPlayerRadius: 28,
    videoPlayerBorderColor: '#38bdf8',
    videoPlayerBorderWidth: 3,
    videoPlayerColor: 'rgba(15, 23, 42, 0.72)',
    videoPlayColor: '#f8fafc',
    videoPlaySize: 82,
    videoPlayRadius: 24,
    videoPlayIconSize: 30,
    videoPlayBorderColor: '#facc15',
    videoPlayBorderWidth: 2,
    videoSoundColor: '#22d3ee'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /rstk-video-custom-controls/)
  assert.match(html, /<button type="button" class="rstk-video-overlay" data-rstk-video-overlay/)
  assert.match(html, /src="https:\/\/cdn\.example\.com\/video\.mp4\?no_track=1"/)
  assert.match(html, /<span class="rstk-video-sound\b/)
  assert.match(html, /--rstk-video-bg:#111827/)
  assert.match(html, /--rstk-video-radius:28px/)
  assert.match(html, /--rstk-video-border-color:#38bdf8/)
  assert.match(html, /--rstk-video-border-width:3px/)
  assert.match(html, /--rstk-video-player-color:rgba\(15, 23, 42, 0\.72\)/)
  assert.match(html, /--rstk-video-play-color:#f8fafc/)
  assert.match(html, /--rstk-video-play-size:82px/)
  assert.match(html, /--rstk-video-play-radius:24px/)
  assert.match(html, /--rstk-video-play-icon-size:30px/)
  assert.match(html, /--rstk-video-play-border-color:#facc15/)
  assert.match(html, /--rstk-video-play-border-width:2px/)
  assert.match(html, /--rstk-video-sound-color:#22d3ee/)
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

test('preview render suppresses custom tracking code without changing live tracking', async () => {
  const site = baseSite({})
  site.theme.headerTrackingCode = '<script>window.__previewTrackingLeak = true</script>'

  const previewHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.doesNotMatch(previewHtml, /__previewTrackingLeak/)
  assert.match(previewHtml, /src="https:\/\/cdn\.example\.com\/video\.mp4\?no_track=1"/)

  const liveHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(liveHtml, /__previewTrackingLeak/)
  assert.match(liveHtml, /src="https:\/\/cdn\.example\.com\/video\.mp4"/)
  assert.doesNotMatch(liveHtml, /video\.mp4\?no_track=1/)
})
