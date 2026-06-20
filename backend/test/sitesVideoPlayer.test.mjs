import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
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

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getHtmlAttribute = (attrs, name) => {
  const match = String(attrs || '').match(new RegExp(`(?:^|\\s)${escapeRegExp(name)}="([^"]*)"`, 'i'))
  return match ? match[1] : ''
}

const hasHtmlBooleanAttribute = (attrs, name) =>
  new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`, 'i').test(String(attrs || ''))

const getVideoPlayerVisualSignature = (html) => {
  const source = String(html || '')
  const hostMatch = source.match(/<div class="([^"]*\brstk-video-player\b[^"]*)" style="([^"]*)">/)
  assert.ok(hostMatch, 'expected rendered custom video player host')

  const videoMatch = source.match(/<video\s+([^>]*)>/)
  assert.ok(videoMatch, 'expected rendered video element')
  const videoAttrs = videoMatch[1]

  return {
    classes: hostMatch[1],
    style: hostMatch[2],
    hasOverlay: /class="rstk-video-overlay"/.test(source),
    hasSoundNotice: /class="rstk-video-sound\b/.test(source),
    soundText: source.match(/<span class="rstk-video-sound-text">([^<]*)<\/span>/)?.[1] || '',
    hasControlBar: /class="rstk-video-control-bar"/.test(source),
    hasPlayControl: /class="rstk-video-control-button" data-rstk-video-toggle/.test(source),
    hasVolumeControl: /class="rstk-video-control-button" data-rstk-video-mute/.test(source),
    hasSpeedControl: /<select data-rstk-video-speed-select/.test(source),
    hasSettingsControl: /<span class="rstk-video-settings-icon" data-rstk-video-settings-icon/.test(source),
    selectedSpeed: source.match(/<option value="([^"]+)" selected>/)?.[1] || '',
    nativeControls: hasHtmlBooleanAttribute(videoAttrs, 'controls'),
    muted: hasHtmlBooleanAttribute(videoAttrs, 'muted'),
    autoplay: hasHtmlBooleanAttribute(videoAttrs, 'autoplay'),
    loop: hasHtmlBooleanAttribute(videoAttrs, 'loop'),
    playsinline: hasHtmlBooleanAttribute(videoAttrs, 'playsinline'),
    preload: getHtmlAttribute(videoAttrs, 'preload'),
    speed: getHtmlAttribute(videoAttrs, 'data-rstk-video-speed'),
    objectFit: getHtmlAttribute(videoAttrs, 'style')
  }
}

test('video player clean mode renders custom overlay controls', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoControlBar: true,
    videoControlPanelRadius: 18,
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
    videoSoundColor: '#22d3ee'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /rstk-video-custom-controls/)
  assert.match(html, /<button type="button" class="rstk-video-overlay" data-rstk-video-overlay/)
  assert.match(html, /src="https:\/\/cdn\.example\.com\/video\.mp4"/)
  assert.match(html, /data-rstk-video-src="https:\/\/cdn\.example\.com\/video\.mp4"/)
  assert.doesNotMatch(html, /video\.mp4\?no_track=1/)
  assert.match(html, /<span class="rstk-video-sound\b/)
  assert.match(html, /--rstk-video-bg:#111827/)
  assert.match(html, /--rstk-video-radius:28px/)
  assert.match(html, /--rstk-video-border-color:#38bdf8/)
  assert.match(html, /--rstk-video-border-width:3px/)
  assert.match(html, /--rstk-video-player-color:rgba\(15, 23, 42, 0\.72\)/)
  assert.match(html, /--rstk-video-play-color:#f8fafc/)
  assert.match(html, /--rstk-video-control-radius:18px/)
  assert.match(html, /--rstk-video-play-size:82px/)
  assert.match(html, /--rstk-video-play-radius:24px/)
  assert.match(html, /--rstk-video-play-icon-size:30px/)
  assert.doesNotMatch(html, /--rstk-video-play-border-/)
  assert.match(html, /--rstk-video-sound-color:#22d3ee/)
  assert.match(html, /\.rstk-video-overlay\{[^}]*background:transparent/)
  assert.match(html, /\.rstk-video-play-dot\{[^}]*box-shadow:none/)
  assert.match(html, /\.rstk-video-play-dot\{[^}]*border:0/)
  assert.match(html, /\.rstk-video-control-bar\{[^}]*display:flex[^}]*border-radius:var\(--rstk-video-control-radius,24px\)[^}]*background:var\(--rstk-video-player-color/)
  assert.match(html, /\.rstk-video-control-bar\{[^}]*box-shadow:none/)
  assert.match(html, /data-rstk-video-toggle/)
  assert.match(html, /data-rstk-video-settings-icon/)
  assert.match(html, /data-rstk-video-progress-track role="slider" tabindex="0"/)
  assert.match(html, /aria-label="Progreso del video"/)
  assert.match(html, /\.rstk-video-control-button svg\{[^}]*width:15px[^}]*height:15px/)
  assert.match(html, /\.rstk-video-progress\{[^}]*flex:1 1 44px[^}]*cursor:pointer[^}]*touch-action:none/)
  assert.match(html, /\.rstk-video-progress::before\{[^}]*height:5px/)
  assert.match(html, /requestAnimationFrame/)
  assert.match(html, /formatProgressPercent/)
  assert.doesNotMatch(html, /progress\.style\.width = Math\.round/)
  assert.match(html, /\.rstk-video-controls-hidden \.rstk-video-control-bar\{[^}]*opacity:0/)
  assert.match(html, /\.rstk-video-player\{container-type:inline-size/)
  assert.match(html, /15cqw/)
  assert.match(html, /22cqw/)
  assert.match(html, /rstk-video-control-play svg\{transform:translateX\(1px\)/)
  assert.match(html, /-webkit-appearance:none;appearance:none/)
  assert.match(html, /box-shadow:none!important/)
  assert.match(html, /12cqw/)
  assert.match(html, /18cqw/)
})

test('video player default preset uses large rectangular solid play button', async () => {
  const html = await renderPublicSiteHtml(baseSite({}), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.match(signature.classes, /\brstk-video-play-shape-rectangle\b/)
  assert.match(signature.classes, /\brstk-video-play-solid\b/)
  assert.match(signature.style, /--rstk-video-player-color:#000000/)
  assert.match(signature.style, /--rstk-video-play-width:232px/)
  assert.match(signature.style, /--rstk-video-play-size:160px/)
  assert.match(signature.style, /--rstk-video-play-radius:0px/)
  assert.match(signature.style, /--rstk-video-play-icon-size:95px/)
  assert.match(html, /data-rstk-video-preview="true"/)
  assert.match(html, /data-rstk-video-preview-start="0"/)
  assert.match(html, /data-rstk-video-preview-end="40"/)
  assert.equal(signature.hasSoundNotice, true)
  assert.equal(signature.soundText, 'Haz clic para activar el sonido')
  assert.match(html, /<\/button>\s*<span class="rstk-video-sound\b/)
  assert.match(signature.classes, /\brstk-video-landscape\b/)
  assert.match(signature.style, /--rstk-video-aspect-ratio:16 \/ 9/)
})

test('video player portrait format uses vertical ratio and contained desktop width', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoOrientation: 'portrait'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.match(signature.classes, /\brstk-video-portrait\b/)
  assert.doesNotMatch(signature.classes, /\brstk-video-landscape\b/)
  assert.match(signature.style, /--rstk-video-aspect-ratio:9 \/ 16/)
  assert.match(signature.style, /--rstk-media-width:44%/)
  assert.match(html, /\.rstk-video\{aspect-ratio:var\(--rstk-video-aspect-ratio,16\/9\)/)
  assert.match(html, /\.rstk-video-portrait\{aspect-ratio:var\(--rstk-video-aspect-ratio,9\/16\)/)
  assert.match(html, /@media \(max-width:760px\)\{\.rstk-block-style \.rstk-video-portrait\{width:100%;margin-left:auto;margin-right:auto\}\}/)
})

test('video player custom bar can hide individual controls and keep editable panel radius', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoControlBar: true,
    videoControlPlay: false,
    videoControlVolume: false,
    videoControlSpeed: true,
    videoControlSettings: false,
    videoControlPanelRadius: 6,
    videoDefaultSpeed: 1.5
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.equal(signature.hasControlBar, true)
  assert.equal(signature.hasPlayControl, false)
  assert.equal(signature.hasVolumeControl, false)
  assert.equal(signature.hasSpeedControl, true)
  assert.equal(signature.hasSettingsControl, false)
  assert.equal(signature.selectedSpeed, '1.5')
  assert.match(signature.style, /--rstk-video-control-radius:6px/)
  assert.match(html, /class="rstk-video-speed-control rstk-video-speed-no-settings"/)
  assert.match(html, /data-rstk-video-progress-track role="slider" tabindex="0"/)
})

test('video player defaults hide the custom control bar at initial render', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoControlBar: true
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.equal(signature.hasControlBar, true)
  assert.match(signature.classes, /\brstk-video-controls-hidden\b/)
  assert.doesNotMatch(signature.classes, /\brstk-video-controls-visible\b/)
})

test('video player renders configurable first-seconds preview loop settings', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoPreviewEnabled: true,
    videoPreviewStart: 12.4,
    videoPreviewEnd: 55
  }), {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(html, /data-rstk-video-preview="true"/)
  assert.match(html, /data-rstk-video-preview-start="12\.5"/)
  assert.match(html, /data-rstk-video-preview-end="52\.5"/)
  assert.match(html, /const previewMaxSpan = 40/)
  assert.match(html, /rstkVideoPreviewing === 'true'/)
  assert.match(html, /rstkVideoPreviewing/)
  assert.doesNotMatch(html, /rstk-video-is-playing:hover \.rstk-video-play-dot/)

  const autoplayHtml = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoPreviewEnabled: true,
    videoPreviewStart: 3,
    videoPreviewEnd: 11,
    videoAutoplay: true
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(autoplayHtml, /autoplay/)
  assert.match(autoplayHtml, /data-rstk-video-preview="false"/)
  assert.match(autoplayHtml, /data-rstk-video-preview-start="3"/)
  assert.match(autoplayHtml, /data-rstk-video-preview-end="11"/)
})

test('video player uses the same visual signature for direct and Bunny Stream renders', async () => {
  const assetId = `site_parity_stream_${Date.now()}`
  const plainUrl = 'https://cdn.example.com/sites/plain-parity-video.mp4'
  const storageUrl = `https://cdn.example.com/sites/${assetId}.mp4`
  const streamVideoId = `stream-${assetId}`
  const visualSettings = {
    videoControlsMode: 'clean',
    videoControlBar: true,
    videoControlVolume: true,
    videoControlSpeed: true,
    videoPreviewEnabled: true,
    videoSoundHint: true,
    videoSoundNoticeText: 'Toca para escuchar',
    videoSoundNoticeHideAfter: 8,
    videoMuted: true,
    videoAutoplay: false,
    videoLoop: false,
    videoDefaultSpeed: 1.25,
    videoFit: 'contain',
    videoPlayerBackground: '#050505',
    videoPlayerRadius: 31,
    videoPlayerBorderColor: '#a855f7',
    videoPlayerBorderWidth: 5,
    videoPlayerColor: 'rgba(19, 51, 255, 0.66)',
    videoPlayColor: '#fafafa',
    videoPlaySize: 104,
    videoPlayShape: 'rectangle',
    videoPlayRadius: 17,
    videoPlayIconStyle: 'spark',
    videoPlayIconSize: 48,
    videoSoundColor: '#facc15'
  }
  const expectedEditorInitialClasses = [
    'rstk-video',
    'rstk-video-player',
    'rstk-video-custom-controls',
    'rstk-video-has-control-bar',
    'rstk-video-controls-hidden',
    'rstk-video-sound-hint',
    'rstk-video-is-muted',
    'rstk-video-landscape',
    'rstk-video-play-shape-rectangle',
    'rstk-video-play-spark'
  ].join(' ')

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
        'site_video_player',
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

    const render = (site, options) => renderPublicSiteHtml(site, {
      pageId: 'page-1',
      ...options
    })
    const plainSite = baseSite({ ...visualSettings, mediaUrl: plainUrl })
    const streamSite = baseSite({ ...visualSettings, mediaUrl: storageUrl })

    const plainPreviewHtml = await render(plainSite, { trackingEnabled: false, preview: true })
    const plainLiveHtml = await render(plainSite, { trackingEnabled: true, preview: false })
    const streamPreviewHtml = await render(streamSite, { trackingEnabled: false, preview: true })
    const streamLiveHtml = await render(streamSite, { trackingEnabled: true, preview: false })

    const plainPreviewSignature = getVideoPlayerVisualSignature(plainPreviewHtml)
    assert.equal(plainPreviewSignature.classes, expectedEditorInitialClasses)
    assert.equal(plainPreviewSignature.soundText, 'Toca para escuchar')
    assert.deepEqual(getVideoPlayerVisualSignature(plainLiveHtml), plainPreviewSignature)
    assert.deepEqual(getVideoPlayerVisualSignature(streamPreviewHtml), plainPreviewSignature)
    assert.deepEqual(getVideoPlayerVisualSignature(streamLiveHtml), plainPreviewSignature)

    assert.match(plainLiveHtml, /data-rstk-video-provider="html5_video"/)
    assert.match(streamLiveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(streamLiveHtml, new RegExp(`data-rstk-media-asset-id="${escapeRegExp(assetId)}"`))
    assert.match(streamLiveHtml, new RegExp(`data-rstk-stream-video-id="${escapeRegExp(streamVideoId)}"`))
    assert.doesNotMatch(streamPreviewHtml, /<iframe[^>]+player\.mediadelivery\.net\/embed/)
    assert.doesNotMatch(streamLiveHtml, /<iframe[^>]+player\.mediadelivery\.net\/embed/)

    const autoplayHtml = await render(baseSite({
      ...visualSettings,
      mediaUrl: plainUrl,
      videoAutoplay: true
    }), { trackingEnabled: false, preview: true })
    const autoplaySignature = getVideoPlayerVisualSignature(autoplayHtml)
    assert.equal(autoplaySignature.classes, [
      'rstk-video',
      'rstk-video-player',
      'rstk-video-custom-controls',
      'rstk-video-has-control-bar',
      'rstk-video-controls-hidden',
      'rstk-video-is-muted',
      'rstk-video-landscape',
      'rstk-video-play-shape-rectangle',
      'rstk-video-play-spark'
    ].join(' '))
    assert.equal(autoplaySignature.hasSoundNotice, false)
    assert.match(streamLiveHtml, /const controlsIdleMs = 2600/)
    assert.match(streamLiveHtml, /const controlsLeaveIdleMs = 650/)
    assert.match(streamLiveHtml, /setControlsVisible\(false\)/)
    assert.match(streamLiveHtml, /rstk-video-controls-hidden/)
    assert.match(streamLiveHtml, /showControlsTemporarily\(\)/)
    assert.match(streamLiveHtml, /startsWithHiddenControls/)
    assert.match(streamLiveHtml, /shouldHideControlsAtStart/)
    assert.match(streamLiveHtml, /seekToProgressRatio/)
    assert.match(streamLiveHtml, /seekToClientPosition/)
    assert.match(streamLiveHtml, /pointerdown/)
    assert.match(streamLiveHtml, /ArrowRight/)

    const hiddenInitialSettings = {
      ...visualSettings,
      videoControlBarInitiallyVisible: false
    }
    const plainHiddenHtml = await render(baseSite({
      ...hiddenInitialSettings,
      mediaUrl: plainUrl
    }), { trackingEnabled: false, preview: true })
    const streamHiddenHtml = await render(baseSite({
      ...hiddenInitialSettings,
      mediaUrl: storageUrl
    }), { trackingEnabled: true, preview: false })
    const hiddenInitialSignature = getVideoPlayerVisualSignature(plainHiddenHtml)

    assert.match(hiddenInitialSignature.classes, /\brstk-video-controls-hidden\b/)
    assert.doesNotMatch(hiddenInitialSignature.classes, /\brstk-video-controls-visible\b/)
    assert.deepEqual(getVideoPlayerVisualSignature(streamHiddenHtml), hiddenInitialSignature)

    const visibleInitialSettings = {
      ...visualSettings,
      videoControlBarInitiallyVisible: true
    }
    const plainVisibleHtml = await render(baseSite({
      ...visibleInitialSettings,
      mediaUrl: plainUrl
    }), { trackingEnabled: false, preview: true })
    const streamVisibleHtml = await render(baseSite({
      ...visibleInitialSettings,
      mediaUrl: storageUrl
    }), { trackingEnabled: true, preview: false })
    const visibleInitialSignature = getVideoPlayerVisualSignature(plainVisibleHtml)

    assert.match(visibleInitialSignature.classes, /\brstk-video-controls-visible\b/)
    assert.doesNotMatch(visibleInitialSignature.classes, /\brstk-video-controls-hidden\b/)
    assert.deepEqual(getVideoPlayerVisualSignature(streamVisibleHtml), visibleInitialSignature)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('video player auto orientation uses portrait dimensions from storage assets', async () => {
  const assetId = `site_portrait_stream_${Date.now()}`
  const storageUrl = `https://cdn.example.com/sites/${assetId}.mp4`
  const streamVideoId = `stream-${assetId}`

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, width, height, duration, status,
        storage_provider, module, module_entity_id, is_public, metadata_json
      ) VALUES (?, 'default', 'portrait.mp4', 'portrait.mp4', ?, ?, 'video/mp4', 'video', 'mp4', 128, 128, 128, 720, 1280, 12, 'ready', 'bunny', 'sites', ?, 1, ?)`,
      [
        assetId,
        `sites/${assetId}.mp4`,
        storageUrl,
        'site_video_player',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId,
            video: {
              width: 720,
              height: 1280,
              length: 12
            }
          }
        })
      ]
    )

    const html = await renderPublicSiteHtml(baseSite({
      mediaUrl: storageUrl
    }), {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })
    const signature = getVideoPlayerVisualSignature(html)

    assert.match(signature.classes, /\brstk-video-portrait\b/)
    assert.doesNotMatch(signature.classes, /\brstk-video-landscape\b/)
    assert.match(signature.style, /--rstk-video-aspect-ratio:9 \/ 16/)
    assert.match(signature.style, /--rstk-media-width:44%/)
    assert.match(html, new RegExp(`data-rstk-media-asset-id="${escapeRegExp(assetId)}"`))
    assert.match(html, new RegExp(`data-rstk-stream-video-id="${escapeRegExp(streamVideoId)}"`))
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
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
  assert.match(previewHtml, /src="https:\/\/cdn\.example\.com\/video\.mp4"/)
  assert.doesNotMatch(previewHtml, /video\.mp4\?no_track=1/)

  const liveHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(liveHtml, /__previewTrackingLeak/)
  assert.match(liveHtml, /src="https:\/\/cdn\.example\.com\/video\.mp4"/)
  assert.doesNotMatch(liveHtml, /video\.mp4\?no_track=1/)
})

test('live site tracking persists visitor identity with first-party cookies', async () => {
  const liveHtml = await renderPublicSiteHtml(baseSite({}), {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(liveHtml, /ristak_vid/)
  assert.match(liveHtml, /ristak_sid/)
  assert.match(liveHtml, /SameSite=Lax/)
  assert.match(liveHtml, /rkvi_id/)
})

test('video player treats Ristak media file routes as playable video sources', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    mediaUrl: '/media/assets/media_video_123/file',
    videoControlsMode: 'clean'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /rstk-video-custom-controls/)
  assert.match(html, /<video src="\/media\/assets\/media_video_123\/file" data-rstk-video-src="\/media\/assets\/media_video_123\/file"/)
  assert.doesNotMatch(html, /<iframe src="\/media\/assets\/media_video_123\/file"/)
})

test('video player prepares HLS sources for Bunny Stream playback', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    mediaUrl: 'https://vz-123.b-cdn.net/stream-video/playlist.m3u8',
    videoControlsMode: 'clean'
  }), {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(html, /data-rstk-video-src="https:\/\/vz-123\.b-cdn\.net\/stream-video\/playlist\.m3u8"/)
  assert.doesNotMatch(html, /<video src="https:\/\/vz-123\.b-cdn\.net\/stream-video\/playlist\.m3u8"/)
  assert.match(html, /hls\.js@1\/dist\/hls\.min\.js/)
})

test('live Bunny Stream iframe uses the same editable video frame settings', async () => {
  const streamVideoId = `stream-frame-${Date.now()}`
  const html = await renderPublicSiteHtml(baseSite({
    mediaUrl: `https://player.mediadelivery.net/embed/123456/${streamVideoId}`,
    videoPlayerBackground: '#101010',
    videoPlayerRadius: 22,
    videoPlayerBorderColor: 'rgba(255, 255, 255, 0)',
    videoPlayerBorderWidth: 4
  }), {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  assert.match(html, /class="[^"]*\brstk-video-stream-frame\b[^"]*\brstk-video-landscape\b[^"]*" style="[^"]*--rstk-video-bg:#101010/)
  assert.match(html, /class="[^"]*\brstk-video-stream-frame\b[^"]*" style="[^"]*--rstk-video-radius:22px/)
  assert.match(html, /class="[^"]*\brstk-video-stream-frame\b[^"]*" style="[^"]*--rstk-video-border-color:var\(--rstk-border\)/)
  assert.match(html, /class="[^"]*\brstk-video-stream-frame\b[^"]*" style="[^"]*--rstk-video-border-width:4px/)
  assert.match(html, new RegExp(`src="https://player\\.mediadelivery\\.net/embed/123456/${escapeRegExp(streamVideoId)}\\?rstk_play_id=[^"]+"`))
  assert.match(html, /data-rstk-video-track="true"/)
  assert.match(html, /data-rstk-video-provider="bunny_stream"/)
  assert.match(html, new RegExp(`data-rstk-stream-video-id="${escapeRegExp(streamVideoId)}"`))
  assert.doesNotMatch(html, /class="[^"]*\brstk-video-player\b/)
})

test('live render keeps the custom player style when a storage video is synced to Bunny Stream', async () => {
  const assetId = `site_stream_asset_${Date.now()}`
  const storageUrl = `https://cdn.example.com/sites/${assetId}.mp4`
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
        'site_video_player',
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

    const site = baseSite({
      mediaUrl: storageUrl,
      videoAutoplay: true,
      videoMuted: false,
      videoLoop: true
    })

    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    const escapedStorageUrl = storageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(previewHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.match(previewHtml, new RegExp(`data-rstk-video-src="${escapedStorageUrl}"`))
    assert.doesNotMatch(previewHtml, /no_track=1/)
    assert.doesNotMatch(previewHtml, /player\.mediadelivery\.net\/embed/)
    assert.doesNotMatch(previewHtml, /ristakVideoTrackingLoaded/)

    const liveHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(liveHtml, /rstk-video-player/)
    assert.match(liveHtml, /rstk-video-custom-controls/)
    assert.match(liveHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-video-src="${escapedStorageUrl}"`))
    assert.match(liveHtml, /data-rstk-video-track="true"/)
    assert.match(liveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(liveHtml, new RegExp(`data-rstk-media-asset-id="${assetId}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-stream-video-id="${streamVideoId}"`))
    assert.match(liveHtml, /data-rstk-playback-id="[^"]+"/)
    assert.doesNotMatch(liveHtml, /<iframe[^>]+player\.mediadelivery\.net\/embed/)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('editor-style preview does not load manually pasted Bunny Stream embeds', async () => {
  const assetId = `site_manual_stream_${Date.now()}`
  const storageUrl = `https://cdn.example.com/sites/${assetId}.mp4`
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
        'site_video_player',
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

    const site = baseSite({
      mediaUrl: `https://player.mediadelivery.net/embed/123456/${streamVideoId}`
    })

    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    const escapedStorageUrl = storageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(previewHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.match(previewHtml, new RegExp(`data-rstk-video-src="${escapedStorageUrl}"`))
    assert.doesNotMatch(previewHtml, /no_track=1/)
    assert.doesNotMatch(previewHtml, /player\.mediadelivery\.net\/embed/)
    assert.doesNotMatch(previewHtml, /ristakVideoTrackingLoaded/)

    const liveHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(liveHtml, /rstk-video-player/)
    assert.match(liveHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-video-src="${escapedStorageUrl}"`))
    assert.match(liveHtml, /data-rstk-video-track="true"/)
    assert.match(liveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(liveHtml, new RegExp(`data-rstk-media-asset-id="${assetId}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-stream-video-id="${streamVideoId}"`))
    assert.doesNotMatch(liveHtml, /<iframe[^>]+player\.mediadelivery\.net\/embed/)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})
