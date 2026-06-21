import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPublicSiteHtml } from '../src/services/sitesService.js'

function calendarSite(settings = {}) {
  return {
    id: 'site_calendar_embed_render',
    name: 'Landing con calendario',
    title: 'Landing con calendario',
    description: '',
    slug: 'landing-calendario',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'calendar-block',
        siteId: 'site_calendar_embed_render',
        blockType: 'calendar_embed',
        label: 'Calendario',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          calendarSlug: 'agenda-principal',
          calendarName: 'Agenda principal',
          ...settings
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }
}

function getCalendarFrameUrl(html) {
  const match = html.match(/<iframe class="rstk-embed rstk-calendar-embed" src="([^"]+)"/)
  assert.ok(match, 'calendar iframe should render')
  return new URL(match[1].replace(/&amp;/g, '&'), 'https://example.test')
}

test('site calendar preview is interactive but flagged as non-booking preview', async () => {
  const html = await renderPublicSiteHtml(calendarSite({
    calendarDesignMode: 'original',
    calendarLayout: 'stacked',
    calendarCoverImage: '/media/calendar-cover.png',
    calendarAccentColor: '#ff0055',
    calendarSlotRadius: 18
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  const url = getCalendarFrameUrl(html)

  assert.equal(url.pathname, '/calendar/agenda-principal')
  assert.equal(url.searchParams.get('test'), '1')
  assert.equal(url.searchParams.get('embed'), '1')
  assert.equal(url.searchParams.get('editor_preview'), '1')
  assert.equal(url.searchParams.get('designMode'), 'original')
  assert.equal(url.searchParams.get('layout'), 'stacked')
  assert.equal(url.searchParams.get('coverImage'), '/media/calendar-cover.png')
  assert.equal(url.searchParams.get('accent'), null)
  assert.equal(url.searchParams.get('slotRadius'), null)
})

test('site calendar custom mode passes editable style params for live embeds', async () => {
  const html = await renderPublicSiteHtml(calendarSite({
    calendarDesignMode: 'custom',
    calendarLayout: 'compact',
    calendarAccentColor: '#ff0055',
    calendarSlotRadius: 18,
    calendarFieldRadius: 12
  }), {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  const url = getCalendarFrameUrl(html)

  assert.equal(url.searchParams.get('editor_preview'), null)
  assert.equal(url.searchParams.get('designMode'), 'custom')
  assert.equal(url.searchParams.get('layout'), 'compact')
  assert.equal(url.searchParams.get('accent'), '#ff0055')
  assert.equal(url.searchParams.get('slotRadius'), '18')
  assert.equal(url.searchParams.get('fieldRadius'), '12')
})
