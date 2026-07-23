import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

const baseSite = (videoActions = []) => ({
  id: 'site_video_action_conditions',
  name: 'Condiciones de acciones de video',
  title: 'Condiciones de acciones de video',
  description: '',
  slug: 'condiciones-video',
  siteType: 'landing_page',
  status: 'published',
  theme: {
    template: 'ristak',
    pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
  },
  blocks: [
    {
      id: 'video-block',
      siteId: 'site_video_action_conditions',
      blockType: 'video',
      label: 'Video',
      content: '',
      placeholder: '',
      required: false,
      options: [],
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.test/video.mp4',
        videoActions
      },
      createdAt: '',
      updatedAt: ''
    },
    ...['timeline-target', 'playback-target', 'coverage-target', 'skip-target'].map((id, index) => ({
      id,
      siteId: 'site_video_action_conditions',
      blockType: 'text',
      label: id,
      content: id,
      placeholder: '',
      required: false,
      options: [],
      sortOrder: index + 1,
      settings: { pageId: 'page-1' },
      createdAt: '',
      updatedAt: ''
    }))
  ]
})

const decodeHtmlAttribute = value => String(value || '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

const getPublicActions = html => {
  const match = String(html).match(/data-rstk-video-actions="([^"]*)"/)
  assert.ok(match, 'expected public video action payload')
  return JSON.parse(decodeHtmlAttribute(match[1]))
}

const getRuntimeScript = html => {
  const script = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(source => source.includes('ristakVideoActionsRuntimeLoaded'))
  assert.ok(script, 'expected video action runtime')
  return script
}

test('video action normalization keeps legacy time rules and accepts declarative aliases', async () => {
  const html = await renderPublicSiteHtml(baseSite([
    {
      id: 'legacy-timeline',
      timeSeconds: 12,
      action: 'show',
      targetBlockId: 'timeline-target',
      before: 'hidden'
    },
    {
      id: 'nested-playback',
      timeSeconds: 55,
      trigger: { type: 'playback_seconds', value: 3.7 },
      action: 'show',
      targetIds: ['playback-target'],
      before: 'hidden'
    },
    {
      id: 'snake-coverage',
      trigger_type: 'unique_watched_percent',
      trigger_value: 180,
      action: 'show',
      target_ids: ['coverage-target'],
      before: 'hidden'
    },
    {
      id: 'minimum-coverage',
      triggerType: 'unique_watched_percent',
      triggerValue: 0,
      action: 'show',
      targetBlockId: 'skip-target',
      before: 'hidden'
    }
  ]), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  const actions = getPublicActions(html)
  const legacy = actions.find(action => action.id === 'legacy-timeline')
  const playback = actions.find(action => action.id === 'nested-playback')
  const coverage = actions.find(action => action.id === 'snake-coverage')
  const minimumCoverage = actions.find(action => action.id === 'minimum-coverage')

  assert.deepEqual(
    { timeSeconds: legacy.timeSeconds, triggerType: legacy.triggerType, triggerValue: legacy.triggerValue },
    { timeSeconds: 12, triggerType: 'timeline_reached', triggerValue: 12 }
  )
  assert.deepEqual(
    {
      timeSeconds: playback.timeSeconds,
      triggerType: playback.triggerType,
      triggerValue: playback.triggerValue,
      targetBlockIds: playback.targetBlockIds
    },
    { timeSeconds: 55, triggerType: 'playback_seconds', triggerValue: 4, targetBlockIds: ['playback-target'] }
  )
  assert.deepEqual(
    { timeSeconds: coverage.timeSeconds, triggerType: coverage.triggerType, triggerValue: coverage.triggerValue },
    { timeSeconds: 0, triggerType: 'unique_watched_percent', triggerValue: 100 }
  )
  assert.equal(minimumCoverage.triggerValue, 1)
})

test('video runtime separates timeline seeks, active playback time and unique watched coverage', async () => {
  const html = await renderPublicSiteHtml(baseSite([
    {
      id: 'timeline-rule',
      timeSeconds: 80,
      action: 'show',
      targetBlockId: 'timeline-target',
      before: 'hidden'
    },
    {
      id: 'playback-rule',
      triggerType: 'playback_seconds',
      triggerValue: 3,
      action: 'show',
      targetBlockId: 'playback-target',
      before: 'hidden'
    },
    {
      id: 'coverage-rule',
      triggerType: 'unique_watched_percent',
      triggerValue: 4,
      action: 'show',
      targetBlockId: 'coverage-target',
      before: 'hidden'
    },
    {
      id: 'skip-rule',
      triggerType: 'unique_watched_percent',
      triggerValue: 1,
      action: 'show',
      targetBlockId: 'skip-target',
      before: 'hidden'
    }
  ]), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  class FakeVideo {
    constructor(actions) {
      this.attrs = new Map([['data-rstk-video-actions', JSON.stringify(actions)]])
      this.dataset = {}
      this.autoplay = false
      this.paused = true
      this.ended = false
      this.currentTime = 0
      this.duration = 100
      this.playbackRate = 1
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

  const actions = getPublicActions(html)
  const video = new FakeVideo(actions)
  const targets = new Map(['timeline-target', 'playback-target', 'coverage-target', 'skip-target'].map(id => {
    const attrs = new Map([
      ['data-rstk-video-action-hidden', 'true'],
      ['aria-hidden', 'true']
    ])
    return [id, {
      attrs,
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: name => attrs.delete(name)
    }]
  }))
  const findTargetId = selector => [...targets.keys()].find(id => String(selector).includes(id))
  const document = {
    documentElement: {},
    cookie: '',
    referrer: '',
    querySelectorAll: selector => selector === 'video[data-rstk-video-actions]' ? [video] : [],
    querySelector: selector => targets.get(findTargetId(selector)) || null,
    getElementById: id => targets.get(id) || null
  }
  let nowMs = 0
  let frameId = 0
  const window = {
    CSS: { escape: value => String(value) },
    performance: { now: () => nowMs },
    requestAnimationFrame: () => ++frameId,
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'https://example.test/condiciones-video' }
  }
  class MutationObserver {
    observe() {}
  }

  vm.runInNewContext(getRuntimeScript(html), { window, document, MutationObserver })

  const isHidden = id => targets.get(id).attrs.has('data-rstk-video-action-hidden')
  video.paused = false
  video.dispatch('play')

  // Llegar al segundo 80 por seek sí activa timeline, pero no acredita consumo.
  nowMs = 100
  video.currentTime = 80
  video.dispatch('seeking')
  video.dispatch('seeked')
  assert.equal(isHidden('timeline-target'), false)
  assert.equal(isHidden('playback-target'), true)
  assert.equal(isHidden('coverage-target'), true)

  nowMs = 200
  video.currentTime = 0
  video.dispatch('seeking')
  video.dispatch('seeked')
  assert.equal(isHidden('timeline-target'), true)

  // Un player embebido puede omitir seeking/seeked. Saltos pequeños repetidos
  // no deben acreditar como vistos todos los huecos entre posiciones.
  nowMs = 300
  video.currentTime = 1.9
  video.dispatch('timeupdate')
  nowMs = 400
  video.currentTime = 3.8
  video.dispatch('timeupdate')
  nowMs = 500
  video.currentTime = 5.7
  video.dispatch('timeupdate')
  assert.equal(isHidden('skip-target'), true)

  nowMs = 600
  video.currentTime = 0
  video.dispatch('seeking')
  video.dispatch('seeked')

  // Cinco segundos de buffering no cuentan como reproducción.
  video.dispatch('waiting')
  nowMs = 5600
  video.dispatch('timeupdate')
  video.dispatch('playing')

  // Dos segundos vistos acreditan 2s y 2% de cobertura.
  nowMs = 7600
  video.currentTime = 2
  video.dispatch('timeupdate')
  assert.equal(isHidden('playback-target'), true)
  assert.equal(isHidden('coverage-target'), true)

  // Repetir esos mismos dos segundos sí suma playback, pero no cobertura única.
  nowMs = 7700
  video.currentTime = 0
  video.dispatch('seeking')
  video.dispatch('seeked')
  nowMs = 9700
  video.currentTime = 2
  video.dispatch('timeupdate')
  assert.equal(isHidden('playback-target'), false)
  assert.equal(isHidden('coverage-target'), true)

  // Ver dos segundos nuevos completa 4% de contenido único.
  nowMs = 11700
  video.currentTime = 4
  video.dispatch('timeupdate')
  assert.equal(isHidden('coverage-target'), false)
})

test('Bunny bridge closes the final watched range before ended actions run', async () => {
  const site = baseSite([{
    id: 'coverage-complete',
    triggerType: 'unique_watched_percent',
    triggerValue: 100,
    action: 'show',
    targetBlockId: 'coverage-target',
    before: 'hidden'
  }])
  site.blocks[0].settings.mediaUrl = 'https://iframe.mediadelivery.net/embed/123456/video-complete'

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })
  const scripts = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
  const bridgeScript = scripts.find(source => source.includes('data-rstk-stream-action-frame'))
  assert.ok(bridgeScript, 'expected Bunny action bridge')

  class FakeProxyVideo {
    constructor(actions) {
      this.attrs = new Map([['data-rstk-video-actions', JSON.stringify(actions)]])
      this.dataset = {}
      this.autoplay = false
      this.ended = false
      this.playbackRate = 1
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

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) || []) listener(event)
      return true
    }

    closest() {
      return null
    }
  }

  class FakePlayer {
    static instance = null

    constructor() {
      this.listeners = new Map()
      FakePlayer.instance = this
    }

    on(name, listener) {
      this.listeners.set(name, listener)
    }

    emit(name, timing) {
      this.listeners.get(name)?.(timing)
    }

    getDuration(callback) {
      callback(100)
    }

    play() {}
    pause() {}
  }

  const actions = getPublicActions(html)
  const proxy = new FakeProxyVideo(actions)
  const frame = {}
  const targetAttrs = new Map([
    ['data-rstk-video-action-hidden', 'true'],
    ['aria-hidden', 'true']
  ])
  const target = {
    setAttribute: (name, value) => targetAttrs.set(name, String(value)),
    removeAttribute: name => targetAttrs.delete(name)
  }
  const host = {
    querySelector: selector => selector.includes('iframe') ? frame : selector.includes('video') ? proxy : null
  }
  const document = {
    currentScript: { previousElementSibling: host },
    documentElement: {},
    cookie: '',
    referrer: '',
    querySelectorAll: selector => selector === 'video[data-rstk-video-actions]' ? [proxy] : [],
    querySelector: selector => String(selector).includes('coverage-target') ? target : null,
    getElementById: id => id === 'coverage-target' ? target : null,
    head: { appendChild() {} }
  }
  let nowMs = 0
  const window = {
    CSS: { escape: value => String(value) },
    performance: { now: () => nowMs },
    playerjs: { Player: FakePlayer },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'https://example.test/condiciones-video' }
  }
  class FakeEvent {
    constructor(type) {
      this.type = type
    }
  }
  class MutationObserver {
    observe() {}
  }

  const context = { window, document, Event: FakeEvent, MutationObserver }
  vm.runInNewContext(bridgeScript, context)
  vm.runInNewContext(getRuntimeScript(html), context)

  const player = FakePlayer.instance
  assert.ok(player)
  player.emit('ready')
  player.emit('play')
  for (let seconds = 10; seconds <= 90; seconds += 10) {
    nowMs = seconds * 1000
    player.emit('timeupdate', { seconds, duration: 100 })
  }
  nowMs = 99_000
  player.emit('timeupdate', { seconds: 99, duration: 100 })
  assert.equal(targetAttrs.has('data-rstk-video-action-hidden'), true)

  nowMs = 100_000
  player.emit('ended', { duration: 100 })
  assert.equal(proxy.currentTime, 100)
  assert.equal(proxy.ended, true)
  assert.equal(targetAttrs.has('data-rstk-video-action-hidden'), false)
})
