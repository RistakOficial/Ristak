import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { createBlock, createMetaPageEventFromRequest, createSite, deleteSite, renderPublicSiteHtml } from '../src/services/sitesService.js'

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

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

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
    hasProgressControl: /<div class="rstk-video-progress" data-rstk-video-progress-track/.test(source),
    hasPlayControl: /class="rstk-video-control-button" data-rstk-video-toggle/.test(source),
    hasVolumeControl: /class="rstk-video-control-button" data-rstk-video-mute/.test(source),
    hasSpeedControl: /<select data-rstk-video-speed-select/.test(source),
    hasSettingsControl: /<span class="rstk-video-settings-icon" data-rstk-video-settings-icon/.test(source),
    hasTimecodeControl: /<span class="rstk-video-timecode" data-rstk-video-timecode/.test(source),
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
  assert.match(html, /\.rstk-kind-landing \.rstk-video\{[^}]*border-radius:var\(--rstk-video-radius/)
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
  assert.match(html, /data-rstk-video-timecode/)
  assert.match(html, /data-rstk-video-time-elapsed>0:00/)
  assert.match(html, /data-rstk-video-time-remaining>-0:00/)
  assert.match(html, /data-rstk-video-progress-track role="slider" tabindex="-1"/)
  assert.match(html, /aria-label="Progreso del video"/)
  assert.match(html, /\.rstk-video-control-button svg\{[^}]*width:15px[^}]*height:15px/)
  assert.match(html, /\.rstk-video-progress\{[^}]*flex:1 1 44px[^}]*cursor:pointer[^}]*touch-action:none/)
  assert.match(html, /\.rstk-video-progress::before\{[^}]*height:5px/)
  assert.match(html, /requestAnimationFrame/)
  assert.match(html, /formatProgressPercent/)
  assert.match(html, /formatTimecode/)
  assert.match(html, /syncTimecode\(duration\)/)
  assert.doesNotMatch(html, /progress\.style\.width = Math\.round/)
  assert.match(html, /\.rstk-video-controls-hidden \.rstk-video-control-bar\{[^}]*opacity:0/)
  assert.match(html, /\.rstk-video-timecode\{[^}]*font-variant-numeric:tabular-nums/)
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
  assert.match(signature.style, /--rstk-video-player-color:rgba\(0, 0, 0, 0\.40\)/)
  assert.match(signature.style, /--rstk-video-play-color:rgba\(255, 255, 255, 0\.87\)/)
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

test('video player independently hides the central play and progress controls', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoOverlayPlay: false,
    videoControlBar: true,
    videoControlPlay: true,
    videoControlProgress: false,
    videoControlTime: true,
    videoControlVolume: true
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.equal(signature.hasOverlay, false)
  assert.equal(signature.hasControlBar, true)
  assert.equal(signature.hasPlayControl, true)
  assert.equal(signature.hasProgressControl, false)
  assert.equal(signature.hasTimecodeControl, true)
  assert.equal(signature.hasVolumeControl, true)
  assert.doesNotMatch(html, /aria-label="Progreso del video"/)
})

test('video player legacy saved colors resolve to modern translucent defaults', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoPlayerColor: '#000000',
    videoPlayColor: '#FFFFFF'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.match(signature.style, /--rstk-video-player-color:rgba\(0, 0, 0, 0\.40\)/)
  assert.match(signature.style, /--rstk-video-play-color:rgba\(255, 255, 255, 0\.87\)/)
})

test('video player modern color defaults version preserves explicit solid colors', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoPlayerColorDefaultsVersion: 2,
    videoPlayerColor: '#000000',
    videoPlayColor: '#ffffff'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.match(signature.style, /--rstk-video-player-color:#000000/)
  assert.match(signature.style, /--rstk-video-play-color:#ffffff/)
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
  assert.match(signature.classes, /\brstk-video-wauto\b/)
  assert.doesNotMatch(signature.classes, /\brstk-video-landscape\b/)
  assert.match(signature.style, /--rstk-video-aspect-ratio:9 \/ 16/)
  assert.doesNotMatch(signature.style, /--rstk-media-width:44%/)
  assert.match(html, /data-rstk-video-orientation-mode="portrait"/)
  assert.match(html, /if \(orientationMode === 'portrait' \|\| orientationMode === 'landscape'\) return;/)
  assert.match(html, /\.rstk-video\{aspect-ratio:var\(--rstk-video-aspect-ratio,16\/9\)/)
  assert.match(html, /\.rstk-video-portrait\{width:var\(--rstk-media-width,44%\);aspect-ratio:var\(--rstk-video-aspect-ratio,9\/16\)/)
  assert.match(html, /@media \(max-width:760px\)\{\.rstk-block-style \.rstk-video-portrait\.rstk-video-wauto:not\(\.rstk-video-form-gate-fit-wide\)\{width:100%;margin-left:auto;margin-right:auto\}\}/)
})

test('video player manual portrait width keeps per-view media overrides editable', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoOrientation: 'portrait',
    videoPortraitWidthMode: 'framed',
    mediaWidth: 44,
    responsive: { mobile: { mediaWidth: 78 } }
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  const signature = getVideoPlayerVisualSignature(html)

  assert.doesNotMatch(signature.classes, /\brstk-video-wauto\b/)
  assert.doesNotMatch(signature.classes, /\brstk-video-fill-width\b/)
  assert.match(html, /@media \(max-width:640px\)\{\[data-rstk-block-id="video-block"\]\{--rstk-media-width:78%!important\}\}/)
})

test('video player custom bar can hide individual controls and keep editable panel radius', async () => {
  const html = await renderPublicSiteHtml(baseSite({
    videoControlsMode: 'clean',
    videoControlBar: true,
    videoControlPlay: false,
    videoControlVolume: false,
    videoControlSpeed: true,
    videoControlSettings: false,
    videoControlTime: false,
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
  assert.equal(signature.hasTimecodeControl, false)
  assert.equal(signature.selectedSpeed, '1.5')
  assert.match(signature.style, /--rstk-video-control-radius:6px/)
  assert.match(html, /class="rstk-video-speed-control rstk-video-speed-no-settings"/)
  assert.match(html, /data-rstk-video-progress-track role="slider" tabindex="-1"/)
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
  assert.match(html, /const restartFromBeginningForUserPlayback = \(\) =>/)
  assert.match(html, /video\.currentTime = 0/)
  assert.match(html, /restartFromBeginningForUserPlayback\(\);\s+const wasUserPlayed = hasUserPlayed;\s+markUserPlayback\(\);/)
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

test('video actions render public target state and runtime', async () => {
  const site = baseSite({
    videoActions: [
      {
        id: 'show-button-at-260',
        timeSeconds: 260,
        targetBlockId: 'button-target',
        targetBlockIds: ['button-target', 'offer-target'],
        action: 'show',
        before: 'hidden'
      },
      {
        id: 'hide-button-at-520',
        timeSeconds: 520,
        targetBlockId: 'button-target',
        action: 'hide',
        before: 'visible'
      },
      {
        id: 'open-form-at-300',
        timeSeconds: 300,
        targetBlockId: 'form-target',
        targetBlockIds: ['form-target'],
        action: 'open_form',
        before: 'hidden',
        pauseUntilComplete: true
      },
      {
        id: 'page-redirect-at-580',
        timeSeconds: 580,
        action: 'site_page',
        targetPageId: 'page-2',
        before: 'unchanged'
      },
      {
        id: 'meta-event-at-420',
        timeSeconds: 420,
        action: 'meta_event',
        before: 'unchanged',
        metaEventName: 'ViewContent',
        metaEventParameters: {
          value: '10',
          currency: 'MXN',
          contentName: 'Video visto',
          contentCategory: 'VSL',
          custom: [{ key: 'watch_bucket', value: '420s' }]
        }
      }
    ]
  })
  site.theme.pages.push({ id: 'page-2', title: 'Oferta', sortOrder: 1 })
  site.blocks.push({
    id: 'button-target',
    siteId: 'site_video_player',
    blockType: 'button',
    label: 'Botón Agendar llamada',
    content: 'Agendar llamada',
    placeholder: '',
    required: false,
    options: [],
    sortOrder: 1,
    settings: {
      pageId: 'page-1',
      buttonText: 'Agendar llamada',
      buttonUrl: 'https://example.com/agenda'
    },
    createdAt: '',
    updatedAt: ''
  }, {
    id: 'offer-target',
    siteId: 'site_video_player',
    blockType: 'text',
    label: 'Oferta especial',
    content: 'Oferta especial',
    placeholder: '',
    required: false,
    options: [],
    sortOrder: 2,
    settings: {
      pageId: 'page-1'
    },
    createdAt: '',
    updatedAt: ''
  }, {
    id: 'form-target',
    siteId: 'site_video_player',
    blockType: 'form_embed',
    label: 'Formulario de registro',
    content: '',
    placeholder: '',
    required: false,
    options: [],
    sortOrder: 3,
    settings: {
      pageId: 'page-1',
      embeddedBlocks: []
    },
    createdAt: '',
    updatedAt: ''
  })

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  assert.match(html, /data-rstk-video-action-source="video-block"/)
  assert.match(html, /data-rstk-video-action-site-id="site_video_player"/)
  assert.match(html, /data-rstk-video-action-page-id="page-1"/)
  assert.match(html, /data-rstk-video-actions="/)
  assert.match(html, /&quot;id&quot;:&quot;show-button-at-260&quot;/)
  assert.match(html, /&quot;timeSeconds&quot;:260/)
  assert.match(html, /&quot;targetBlockId&quot;:&quot;button-target&quot;/)
  assert.match(html, /&quot;targetBlockIds&quot;:\[&quot;button-target&quot;,&quot;offer-target&quot;\]/)
  assert.match(html, /&quot;action&quot;:&quot;open_form&quot;/)
  assert.match(html, /&quot;pauseUntilComplete&quot;:true/)
  assert.match(html, /&quot;targetPageId&quot;:&quot;page-2&quot;/)
  // Landing PUBLICADO ahora rutea limpio por paso: el target del video-action usa
  // la ruta directa /oferta en vez de quedar bajo el slug del sitio o usar ?page=.
  assert.match(html, /&quot;targetUrl&quot;:&quot;\/oferta&quot;/)
  assert.match(html, /&quot;id&quot;:&quot;meta-event-at-420&quot;/)
  assert.match(html, /&quot;action&quot;:&quot;meta_event&quot;/)
  assert.match(html, /&quot;metaEventName&quot;:&quot;ViewContent&quot;/)
  assert.match(html, /&quot;metaCustomData&quot;:\{[^}]*&quot;content_name&quot;:&quot;Video visto&quot;[^}]*&quot;watch_bucket&quot;:&quot;420s&quot;/)
  assert.match(html, /data-rstk-video-action-target="button-target" data-rstk-video-action-hidden="true" aria-hidden="true"/)
  assert.match(html, /data-rstk-video-action-target="offer-target" data-rstk-video-action-hidden="true" aria-hidden="true"/)
  assert.match(html, /data-rstk-video-action-target="form-target" data-rstk-video-action-hidden="true" aria-hidden="true"/)
  assert.match(html, /\[data-rstk-video-action-hidden="true"\]\{display:none!important\}/)
  assert.match(html, /ristakVideoActionsRuntimeLoaded/)
  assert.match(html, /video\[data-rstk-video-actions\]/)
  assert.match(html, /timeupdate/)
  assert.match(html, /ensureRealPlaybackStarted/)
  assert.match(html, /isPreviewPlayback\(video\) \|\| video\.paused \|\| video\.ended/)
  assert.match(html, /requestAnimationFrame/)
  assert.match(html, /durationchange/)
  assert.match(html, /playing/)
  assert.match(html, /setTargetHidden\(target, false\)/)
  assert.match(html, /setTargetHidden\(target, true\)/)
  assert.match(html, /blockedForms/)
  assert.match(html, /ristak:submitted/)
  assert.match(html, /redirectTo\(action\)/)
  assert.match(html, /sendMetaActionEvent/)
  assert.match(html, /ristakMetaTrackSiteEvent/)
  assert.match(html, /ristakMetaSendServerEvent/)
  assert.match(html, /eventScope: 'video_action'/)
})

test('video popup action renders manual popup surface when automatic trigger is never', async () => {
  const site = baseSite({
    videoActions: [
      {
        id: 'popup-at-10',
        timeSeconds: 10,
        action: 'show_popup',
        before: 'hidden'
      }
    ]
  })
  site.theme.popupTrigger = 'never'

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  assert.match(html, /data-rstk-site-popup/)
  assert.match(html, /data-trigger="never"/)
  assert.match(html, /window\.ristakOpenSitePopup = \(\) => show\(\{ manual: true \}\)/)
  assert.match(html, /&quot;action&quot;:&quot;show_popup&quot;/)
  assert.match(html, /ristakVideoActionsRuntimeLoaded/)
})

test('page view meta event endpoint enriches browser match data', async () => {
  const previousMetaEnv = {
    pixelId: process.env.META_PIXEL_ID,
    datasetId: process.env.META_DATASET_ID,
    accessToken: process.env.META_ACCESS_TOKEN
  }
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  const suffix = Date.now()
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let metaServer
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    process.env.META_PIXEL_ID = 'pixel-page-view-test'
    process.env.META_DATASET_ID = ''
    process.env.META_ACCESS_TOKEN = 'token-page-view-test'
    metaServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        metaCalls.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events_received: 1 }))
      })
    })
    await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    site = await createSite({
      name: 'Landing page view meta',
      slug: `landing-page-view-meta-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      metaCapiEnabled: true,
      theme: {
        template: 'ristak',
        pages: [
          {
            id: 'page-1',
            title: 'Pagina 1',
            sortOrder: 0,
            metaCapiEnabled: true,
            metaTrigger: 'page_view',
            metaEventName: 'ViewContent',
            metaEventParameters: {
              contentName: 'Pagina vista',
              status: 'page_view_match'
            }
          },
          {
            id: 'page-2',
            title: 'Pagina 2',
            sortOrder: 1,
            metaCapiEnabled: true,
            metaTrigger: 'page_view',
            metaEventName: 'none'
          }
        ]
      }
    })

    const result = await createMetaPageEventFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        pageId: 'page-1',
        eventId: 'site_page_view_test_event',
        meta: {
          pageUrl: 'https://example.test/landing?fbclid=fbclid-page-view',
          eventTime: 1700000005000,
          visitorId: 'visitor-page-view',
          fbp: 'fbp-page'
        }
      }
    )

    assert.equal(result.sent, true)
    assert.equal(result.eventName, 'ViewContent')
    assert.equal(metaCalls.length, 1)
    const payload = JSON.parse(metaCalls[0].body)
    assert.equal(payload.data[0].event_name, 'ViewContent')
    assert.equal(payload.data[0].event_time, 1700000005)
    assert.equal(payload.data[0].event_id, 'site_page_view_test_event')
    assert.match(payload.data[0].event_source_url, /^https:\/\/example\.test\/landing\?fbclid=fbclid-page-view\.[A-Za-z0-9]{8}$/)
    assert.equal(payload.data[0].user_data.client_user_agent, 'node-test')
    assert.match(payload.data[0].user_data.fbp, /^fb\.\d+\.\d+\.\d+\.[A-Za-z0-9]{8}$/)
    assert.match(payload.data[0].user_data.fbc, /^fb\.1\.\d+\.fbclid-page-view\.[A-Za-z0-9]{8}$/)
    assert.match(payload.data[0].user_data.external_id, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
    assert.equal(payload.data[0].custom_data.conversion_type, 'page_view')
    assert.equal(payload.data[0].custom_data.content_name, 'Pagina vista')

    const pageViewResult = await createMetaPageEventFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        pageId: 'page-2',
        eventId: 'site_page_view_default_event',
        meta: {
          pageUrl: 'https://example.test/landing/page-2?fbclid=fbclid-page-view-default',
          eventTime: 1700000010000,
          visitorId: 'visitor-page-view-default',
          fbp: 'fbp-page-default'
        }
      }
    )

    assert.equal(pageViewResult.sent, true)
    assert.equal(pageViewResult.eventName, 'PageView')
    assert.equal(metaCalls.length, 2)
    const pageViewPayload = JSON.parse(metaCalls[1].body)
    assert.equal(pageViewPayload.data[0].event_name, 'PageView')
    assert.equal(pageViewPayload.data[0].event_time, 1700000010)
    assert.equal(pageViewPayload.data[0].event_id, 'site_page_view_default_event')
    assert.equal(pageViewPayload.data[0].custom_data.conversion_type, 'page_view')
    assert.equal(pageViewPayload.data[0].custom_data.content_name, 'Pagina 2')
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousMetaEnv.pixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousMetaEnv.pixelId
    if (previousMetaEnv.datasetId === undefined) delete process.env.META_DATASET_ID
    else process.env.META_DATASET_ID = previousMetaEnv.datasetId
    if (previousMetaEnv.accessToken === undefined) delete process.env.META_ACCESS_TOKEN
    else process.env.META_ACCESS_TOKEN = previousMetaEnv.accessToken
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('video action meta event endpoint sends configured CAPI event', async () => {
  const previousMetaEnv = {
    pixelId: process.env.META_PIXEL_ID,
    datasetId: process.env.META_DATASET_ID,
    accessToken: process.env.META_ACCESS_TOKEN
  }
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  const suffix = Date.now()
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let metaServer
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    process.env.META_PIXEL_ID = 'pixel-video-action-test'
    process.env.META_DATASET_ID = ''
    process.env.META_ACCESS_TOKEN = 'token-video-action-test'
    metaServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        metaCalls.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events_received: 1 }))
      })
    })
    await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    site = await createSite({
      name: 'Landing video action meta',
      slug: `landing-video-action-meta-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      metaCapiEnabled: true,
      theme: {
        template: 'ristak',
        pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
      }
    })

    site = await createBlock(site.id, {
      blockType: 'video',
      label: 'Video con CAPI',
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.com/video-action.mp4',
        videoActions: [
          {
            id: 'meta-event-at-75',
            timeSeconds: 75,
            action: 'meta_event',
            before: 'unchanged',
            metaEventName: 'Lead',
            metaEventParameters: {
              value: '99',
              predictedLtv: '450',
              currency: 'MXN',
              status: 'watched_75'
            }
          }
        ]
      }
    })

    const videoBlock = site.blocks.find(block => block.blockType === 'video')
    assert.ok(videoBlock)

    const result = await createMetaPageEventFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${site.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: site.id,
        pageId: 'page-1',
        eventScope: 'video_action',
        videoBlockId: videoBlock.id,
        videoActionId: 'meta-event-at-75',
        eventId: 'site_video_action_test_event',
        meta: {
          pageUrl: 'https://example.test/video',
          params: { fbclid: 'fbclid-video-action' },
          eventTime: 1700000000000,
          visitorId: 'visitor-video-action',
          fbp: 'fbp-test',
          // El servidor no debe confiar en metadata de trigger fabricada por el browser.
          videoActionTriggerType: 'unique_watched_percent',
          videoActionTriggerValue: 99
        }
      }
    )

    assert.equal(result.sent, true)
    assert.equal(result.eventName, 'Lead')
    assert.equal(metaCalls.length, 1)
    const payload = JSON.parse(metaCalls[0].body)
    assert.equal(payload.data[0].event_name, 'Lead')
    assert.equal(payload.data[0].event_time, 1700000000)
    assert.equal(payload.data[0].event_id, 'site_video_action_test_event')
    assert.equal(payload.data[0].user_data.client_user_agent, 'node-test')
    assert.match(payload.data[0].user_data.fbp, /^fb\.\d+\.\d+\.\d+\.[A-Za-z0-9]{8}$/)
    assert.match(payload.data[0].user_data.fbc, /^fb\.1\.\d+\.fbclid-video-action\.[A-Za-z0-9]{8}$/)
    assert.match(payload.data[0].user_data.external_id, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
    assert.equal(payload.data[0].custom_data.conversion_type, 'video_action')
    assert.equal(payload.data[0].custom_data.video_block_id, videoBlock.id)
    assert.equal(payload.data[0].custom_data.video_action_id, 'meta-event-at-75')
    assert.equal(payload.data[0].custom_data.video_action_time_seconds, 75)
    assert.equal(payload.data[0].custom_data.video_action_trigger_type, 'timeline_reached')
    assert.equal(payload.data[0].custom_data.video_action_trigger_value, 75)
    assert.equal(payload.data[0].custom_data.predicted_ltv, 450)
    assert.equal(payload.data[0].custom_data.status, 'watched_75')
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousMetaEnv.pixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousMetaEnv.pixelId
    if (previousMetaEnv.datasetId === undefined) delete process.env.META_DATASET_ID
    else process.env.META_DATASET_ID = previousMetaEnv.datasetId
    if (previousMetaEnv.accessToken === undefined) delete process.env.META_ACCESS_TOKEN
    else process.env.META_ACCESS_TOKEN = previousMetaEnv.accessToken
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('video actions fire when preview playback becomes real without a second play event', async () => {
  const site = baseSite({
    videoActions: [
      {
        id: 'show-button-at-5',
        timeSeconds: 5,
        targetBlockId: 'button-target',
        targetBlockIds: ['button-target'],
        action: 'show',
        before: 'hidden'
      }
    ]
  })
  site.blocks.push({
    id: 'button-target',
    siteId: 'site_video_player',
    blockType: 'button',
    label: 'Botón Agendar llamada',
    content: 'Agendar llamada',
    placeholder: '',
    required: false,
    options: [],
    sortOrder: 1,
    settings: {
      pageId: 'page-1',
      buttonText: 'Agendar llamada',
      buttonUrl: 'https://example.com/agenda'
    },
    createdAt: '',
    updatedAt: ''
  })

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })
  const runtimeScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(script => script.includes('ristakVideoActionsRuntimeLoaded'))
  assert.ok(runtimeScript, 'expected video actions runtime script')

  class FakeVideo {
    constructor(actions) {
      this.attrs = new Map([['data-rstk-video-actions', JSON.stringify(actions)]])
      this.dataset = { rstkVideoPreviewing: 'true' }
      this.autoplay = false
      this.paused = false
      this.ended = false
      this.currentTime = 0
      this.listeners = new Map()
    }

    getAttribute(name) {
      return this.attrs.get(name) || ''
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

  const video = new FakeVideo([
    {
      id: 'show-button-at-5',
      timeSeconds: 5,
      targetBlockId: 'button-target',
      targetBlockIds: ['button-target'],
      action: 'show',
      before: 'hidden'
    }
  ])
  const targetAttrs = new Map([
    ['data-rstk-video-action-hidden', 'true'],
    ['aria-hidden', 'true']
  ])
  const target = {
    setAttribute: (name, value) => targetAttrs.set(name, String(value)),
    removeAttribute: (name) => targetAttrs.delete(name)
  }
  const document = {
    documentElement: {},
    querySelectorAll: (selector) => selector === 'video[data-rstk-video-actions]' ? [video] : [],
    querySelector: (selector) => selector.includes('button-target') ? target : null,
    getElementById: (id) => id === 'button-target' ? target : null
  }
  let frameCallback = null
  const window = {
    CSS: { escape: (value) => String(value) },
    requestAnimationFrame: (callback) => {
      frameCallback = callback
      return 1
    },
    cancelAnimationFrame: () => {
      frameCallback = null
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  class MutationObserver {
    observe() {}
  }

  vm.runInNewContext(runtimeScript, { window, document, MutationObserver })

  video.currentTime = 6
  video.dispatch('timeupdate')
  assert.equal(targetAttrs.get('data-rstk-video-action-hidden'), 'true')
  assert.equal(video.dataset.rstkVideoRealPlayed, undefined)

  delete video.dataset.rstkVideoPreviewing
  video.dispatch('timeupdate')
  assert.equal(targetAttrs.has('data-rstk-video-action-hidden'), false)
  assert.equal(targetAttrs.has('aria-hidden'), false)
  assert.equal(video.dataset.rstkVideoRealPlayed, 'true')
  assert.equal(typeof frameCallback, 'function')
})

test('video player keeps the customized Ristak player in preview and live for Stream-synced assets', async () => {
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
    'rstk-video-controls-start-hidden',
    'rstk-video-sound-hint',
    'rstk-video-is-muted',
    'rstk-video-landscape',
    'rstk-video-wauto',
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
    const streamSite = baseSite({
      ...visualSettings,
      mediaUrl: storageUrl,
      videoActions: [{
        id: 'stream-coverage',
        triggerType: 'unique_watched_percent',
        triggerValue: 50,
        action: 'show',
        targetBlockId: 'oferta-stream',
        before: 'hidden'
      }]
    })

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
    assert.match(streamLiveHtml, new RegExp(`data-rstk-video-src="${escapeRegExp(storageUrl)}"`))

    assert.match(plainLiveHtml, /data-rstk-video-provider="html5_video"/)
    assert.match(streamLiveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(streamLiveHtml, new RegExp(`data-rstk-media-asset-id="${escapeRegExp(assetId)}"`))
    assert.match(streamLiveHtml, new RegExp(`data-rstk-stream-video-id="${escapeRegExp(streamVideoId)}"`))
    assert.doesNotMatch(streamPreviewHtml, /<iframe[^>]+player\.mediadelivery\.net\/embed/)
    assert.doesNotMatch(streamLiveHtml, /<iframe[^>]+(?:player|iframe)\.mediadelivery\.net\/embed/)
    assert.doesNotMatch(streamLiveHtml, /data-rstk-stream-action-proxy/)
    assert.match(streamLiveHtml, /data-rstk-video-actions=/)

    const autoplayHtml = await render(baseSite({
      ...visualSettings,
      mediaUrl: plainUrl,
      videoAutoplay: true
    }), { trackingEnabled: false, preview: true })
    const autoplaySignature = getVideoPlayerVisualSignature(autoplayHtml)
    // Actualizado por la paridad preview/publicado (pipeline #8): el candado
    // inicial de la barra ya no se fuerza en preview — con autoplay la barra
    // arranca visible igual que en el sitio publicado.
    const autoplayLiveHtml = await render(baseSite({
      ...visualSettings,
      mediaUrl: plainUrl,
      videoAutoplay: true
    }), { trackingEnabled: true, preview: false })
    assert.deepEqual(getVideoPlayerVisualSignature(autoplayLiveHtml), autoplaySignature)
    assert.equal(autoplaySignature.classes, [
      'rstk-video',
      'rstk-video-player',
      'rstk-video-custom-controls',
      'rstk-video-has-control-bar',
      'rstk-video-controls-visible',
      'rstk-video-is-muted',
      'rstk-video-landscape',
      'rstk-video-wauto',
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

    assert.match(visibleInitialSignature.classes, /\brstk-video-controls-hidden\b/)
    assert.match(visibleInitialSignature.classes, /\brstk-video-controls-start-hidden\b/)
    assert.doesNotMatch(visibleInitialSignature.classes, /\brstk-video-controls-visible\b/)
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
    assert.match(html, /class="[^"]*rstk-video-player[^"]*rstk-video-portrait[^"]*"/)
    assert.doesNotMatch(html, /rstk-video-stream-frame/)
    assert.doesNotMatch(html, /rstk-video-player[^"]*rstk-video-landscape/)
    assert.match(html, /--rstk-video-aspect-ratio:9 \/ 16/)
    assert.doesNotMatch(html, /--rstk-media-width:44%/)
    assert.match(html, /\.rstk-video-portrait\{width:var\(--rstk-media-width,44%\)/)
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

test('live render keeps a synced Storage video inside the customized Ristak player', async () => {
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
    assert.match(liveHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-video-src="${escapedStorageUrl}"`))
    assert.match(liveHtml, /data-rstk-video-track="true"/)
    assert.match(liveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(liveHtml, new RegExp(`data-rstk-media-asset-id="${assetId}"`))
    assert.match(liveHtml, new RegExp(`data-rstk-stream-video-id="${streamVideoId}"`))
    assert.match(liveHtml, /data-rstk-playback-id="[^"]+"/)
    assert.doesNotMatch(liveHtml, /rstk-video-stream-frame/)
    assert.doesNotMatch(liveHtml, /iframe\.mediadelivery\.net\/embed/)
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
        storage_provider, module, module_entity_id, is_public, metadata_json,
        stream_video_id
      ) VALUES (?, 'default', 'video.mp4', 'video.mp4', ?, ?, 'video/mp4', 'video', 'mp4', 128, 128, 128, 'ready', 'bunny', 'sites', ?, 1, ?, ?)`,
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
        }),
        streamVideoId
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
    assert.doesNotMatch(liveHtml, /rstk-video-stream-frame/)
    assert.doesNotMatch(liveHtml, /iframe\.mediadelivery\.net\/embed/)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('editor preview never loads an unmapped Bunny Stream iframe', async () => {
  const streamVideoId = `stream-preview-fallback-${Date.now()}`
  const embedUrl = `https://iframe.mediadelivery.net/embed/123456/${streamVideoId}`
  const previewHtml = await renderPublicSiteHtml(baseSite({ mediaUrl: embedUrl }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(previewHtml, /data-rstk-preview-stream-disabled="true"/)
  assert.match(previewHtml, /Preparando vista previa del video/)
  assert.doesNotMatch(previewHtml, new RegExp(`<iframe[^>]+src="${escapeRegExp(embedUrl)}`))
  assert.doesNotMatch(previewHtml, /data-rstk-video-track="true"/)
})

test('legacy Stream-only assets stay disabled in preview and remain playable in live render', async () => {
  const assetId = `site_direct_stream_${Date.now()}`
  const streamVideoId = `stream-${assetId}`
  const embedUrl = `https://iframe.mediadelivery.net/embed/123456/${streamVideoId}`

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status,
        storage_provider, module, module_entity_id, is_public, metadata_json,
        stream_video_id
      ) VALUES (?, 'default', 'recording.mov', 'recording.mov', ?, ?, 'video/quicktime', 'video', 'mov', 128, 128, 128, 'ready', 'bunny_stream', 'sites', ?, 1, ?, ?)`,
      [
        assetId,
        `stream/${streamVideoId}`,
        embedUrl,
        'site_video_player',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId
          }
        }),
        streamVideoId
      ]
    )

    const site = baseSite({ mediaUrl: embedUrl })
    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    const liveHtml = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(previewHtml, /data-rstk-preview-stream-disabled="true"/)
    assert.match(previewHtml, /Preparando vista previa del video/)
    assert.doesNotMatch(previewHtml, new RegExp(`<iframe[^>]+src="${escapeRegExp(embedUrl)}`))
    assert.doesNotMatch(previewHtml, /data-rstk-video-track="true"/)

    assert.match(liveHtml, /class="[^"]*\brstk-video-stream-frame\b[^"]*"/)
    assert.match(liveHtml, new RegExp(`<iframe[^>]+src="${escapeRegExp(embedUrl)}`))
    assert.doesNotMatch(liveHtml, new RegExp(`<video[^>]+src="${escapeRegExp(embedUrl)}`))
    assert.doesNotMatch(liveHtml, /class="[^"]*\brstk-video-player\b/)
    assert.match(liveHtml, /data-rstk-video-track="true"/)
    assert.match(liveHtml, /data-rstk-video-provider="bunny_stream"/)
    assert.match(liveHtml, new RegExp(`data-rstk-media-asset-id="${escapeRegExp(assetId)}"`))
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('Bunny Stream page and block backgrounds use autoplaying iframes instead of video tags', async () => {
  const streamVideoId = `stream-background-${Date.now()}`
  const embedUrl = `https://iframe.mediadelivery.net/embed/123456/${streamVideoId}`
  const site = baseSite({
    blockBackgroundMediaType: 'video',
    blockBackgroundImage: embedUrl
  })
  site.theme = {
    ...site.theme,
    backgroundMediaType: 'video',
    backgroundImage: embedUrl
  }

  for (const options of [
    { trackingEnabled: false, preview: true },
    { trackingEnabled: true, preview: false }
  ]) {
    const html = await renderPublicSiteHtml(site, {
      pageId: 'page-1',
      ...options
    })

    assert.match(html, new RegExp(`<iframe class="rstk-bg-video" src="${escapeRegExp(embedUrl)}\?[^\"]+"`))
    assert.match(html, new RegExp(`<iframe class="rstk-block-bg-video" src="${escapeRegExp(embedUrl)}\?[^\"]+"`))
    assert.match(html, /autoplay=true/)
    assert.match(html, /muted=true/)
    assert.match(html, /loop=true/)
    assert.match(html, /controls=false/)
    assert.doesNotMatch(html, new RegExp(`<video class="rstk-(?:block-)?bg-video" src="${escapeRegExp(embedUrl)}`))
  }
})
