import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeCalendarBookingCompletionConfig,
  normalizeCalendarCustomEventsConfig,
  renderPublicCalendarHtml
} from '../src/services/localCalendarService.js'
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
    calendarSlotRadius: 18,
    embedHeight: 760
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
  // El selector de layout se eliminó: el bloque siempre usa el layout clásico,
  // ignorando cualquier valor guardado (aquí 'stacked').
  assert.equal(url.searchParams.get('layout'), 'classic')
  assert.equal(url.searchParams.get('coverImage'), '/media/calendar-cover.png')
  assert.equal(url.searchParams.get('accent'), null)
  assert.equal(url.searchParams.get('slotRadius'), null)
  assert.match(html, /--rstk-embed-height:760px/)
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
  // Layout siempre clásico aunque se guarde 'compact'.
  assert.equal(url.searchParams.get('layout'), 'classic')
  assert.equal(url.searchParams.get('accent'), '#ff0055')
  assert.equal(url.searchParams.get('slotRadius'), '18')
  assert.equal(url.searchParams.get('fieldRadius'), '12')
})

test('site calendar custom mode forwards display toggles and font to the live embed', async () => {
  const html = await renderPublicSiteHtml(calendarSite({
    calendarDesignMode: 'custom',
    calendarShowSidebar: false,
    calendarShowDuration: false,
    calendarFontFamily: 'serif'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('designMode'), 'custom')
  // Toggles apagados viajan como 0; los no tocados viajan encendidos (1).
  assert.equal(url.searchParams.get('showSidebar'), '0')
  assert.equal(url.searchParams.get('showDuration'), '0')
  assert.equal(url.searchParams.get('showIcon'), '1')
  assert.equal(url.searchParams.get('showConfirmation'), '1')
  assert.equal(url.searchParams.get('allowTimezoneSelection'), '1')
  assert.equal(url.searchParams.get('fontFamily'), 'serif')
})

test('site calendar original mode does not force display toggles or font', async () => {
  const html = await renderPublicSiteHtml(calendarSite({
    calendarDesignMode: 'original',
    calendarShowSidebar: false,
    calendarFontFamily: 'serif'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: false
  })

  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('showSidebar'), null)
  assert.equal(url.searchParams.get('fontFamily'), null)
})

test('public calendar applies per-embed display overrides from style params', () => {
  const calendar = {
    id: 'calendar-overrides',
    slug: 'agenda-overrides',
    name: 'Agenda overrides',
    eventTitle: 'Cita demo',
    description: 'Una descripcion',
    slotDuration: 30,
    eventColor: '#146FC5'
  }

  const full = renderPublicCalendarHtml(calendar, { embedded: true })
  assert.match(full, /<section class="intro">/)
  assert.match(full, /<h1>Agenda overrides<\/h1>/)

  const hiddenSidebar = renderPublicCalendarHtml(calendar, {
    embedded: true,
    style: { designMode: 'custom', showSidebar: '0' }
  })
  assert.doesNotMatch(hiddenSidebar, /<section class="intro">/)

  const hiddenName = renderPublicCalendarHtml(calendar, {
    embedded: true,
    style: { designMode: 'custom', showCalendarName: '0' }
  })
  assert.match(hiddenName, /<section class="intro">/)
  assert.doesNotMatch(hiddenName, /<h1>Agenda overrides<\/h1>/)
})

test('public calendar carries booking completion behavior into the booking widget', () => {
  const completion = normalizeCalendarBookingCompletionConfig({
    bookingCompletion: {
      action: 'redirect',
      message: 'Te llevamos a la pagina de gracias.',
      redirectUrl: '/gracias'
    }
  })
  const html = renderPublicCalendarHtml({
    id: 'calendar-public-completion',
    slug: 'agenda-publica',
    name: 'Agenda publica',
    slotDuration: 30,
    eventColor: '#146FC5',
    bookingCompletion: completion
  })

  assert.deepEqual(completion, {
    action: 'redirect',
    message: 'Te llevamos a la pagina de gracias.',
    redirectUrl: '/gracias'
  })
  assert.match(html, /"bookingCompletion":\{"action":"redirect"/)
  assert.match(html, /"redirectUrl":"\/gracias"/)
  assert.match(html, /window\.location\.assign\(completionRedirectUrl\)/)
})

test('public calendar opens date-first and steps into slots then form', () => {
  const html = renderPublicCalendarHtml({
    id: 'calendar-step-flow',
    slug: 'agenda-step-flow',
    name: 'Agenda step flow',
    slotDuration: 45,
    eventColor: '#146FC5'
  })

  assert.equal(html.includes('class="back"'), false)
  assert.equal(html.includes('history.length'), false)
  assert.equal(html.includes('if (/^/(?!/)/.test(text)) return text;'), false)
  assert.ok(html.includes('if (/^\\/(?!\\/)/.test(text)) return text;'))
  assert.match(html, /<h2>Selecciona fecha<\/h2>/)
  assert.match(html, /\.shell:not\(\.dateSelected\):not\(\.bookingActive\) \.timesPane\{display:none\}/)
  assert.match(html, /shell\.classList\.toggle\('dateSelected', step === 'slots'\)/)
  assert.match(html, /shell\.classList\.toggle\('bookingActive', step === 'form'\)/)
  assert.match(html, /resetForm\(key \? 'slots' : 'calendar'\)/)
  assert.match(html, /setStep\('form'\)/)
  assert.match(html, /\.shell\.dateSelected \.intro,\.shell\.dateSelected \.calendarPane/)
  assert.match(html, /data-change-label>Cambiar fecha<\/span>/)
  assert.match(html, /Cambiar fecha y hora/)
})

test('public calendar custom multipage booking form renders as real steps', () => {
  const html = renderPublicCalendarHtml({
    id: 'calendar-custom-form-steps',
    slug: 'agenda-custom-form-steps',
    name: 'Agenda con formulario',
    slotDuration: 30,
    eventColor: '#146FC5',
    bookingDisplay: { formPosition: 'before' }
  }, {
    bookingForm: {
      mode: 'custom',
      formId: 'form_custom_steps',
      formName: 'Solicitud',
      siteType: 'interactive_form',
      pages: [
        { id: 'screen-1', title: 'Bienvenida', sortOrder: 0 },
        { id: 'screen-2', title: 'Datos', sortOrder: 1 }
      ],
      fields: [
        {
          id: 'headline',
          blockType: 'title',
          isContent: true,
          label: '',
          content: 'Primera pantalla',
          pageId: 'screen-1',
          sortOrder: 0
        },
        {
          id: 'email',
          blockType: 'email',
          label: 'Correo',
          placeholder: 'tu@email.com',
          required: true,
          content: '',
          options: [],
          pageId: 'screen-2',
          sortOrder: 0
        }
      ]
    }
  })

  assert.match(html, /\.formPage\[hidden\]\{display:none\}/)
  assert.match(html, /data-form-progress>Pantalla 1 de 2<\/p>/)
  assert.match(html, /<div class="formPage" data-form-page="screen-1">/)
  assert.match(html, /<div class="formPage" data-form-page="screen-2" hidden>/)
  assert.match(html, /<button class="submit" type="button" data-form-next>Siguiente<\/button>/)
  assert.match(html, /<button class="submit" type="submit" hidden disabled data-submit>Selecciona un horario<\/button>/)
  assert.match(html, /const validateAllPages = \(\) => validatePagesThrough\(formPages\.length - 1\);/)
  assert.match(html, /if \(submit\) \{ submit\.disabled = immediateDisqualified; submit\.textContent = 'Continuar'; \}/)
  assert.doesNotMatch(html, /submit\.hidden = false; submit\.disabled = immediateDisqualified; submit\.textContent = 'Continuar';/)
  assert.match(html, /if \(formFirst && gatePassed && submit\) submit\.hidden = false;/)
})

test('public calendar normalizes custom Meta events for site appointments', () => {
  const customEvents = normalizeCalendarCustomEventsConfig({
    customEvents: {
      enabled: true,
      channel: 'site',
      eventName: 'Schedule',
      parameters: {
        value: '1500',
        currency: 'mxn',
        custom: [{ key: 'pipeline_stage', value: 'demo' }]
      }
    }
  })
  const html = renderPublicCalendarHtml({
    id: 'calendar-meta-site',
    slug: 'agenda-meta',
    name: 'Agenda Meta',
    customEvents
  }, {
    metaPixelSnippet: '<script>window.ristakMetaTrackCalendarEvent=function(){}</script>'
  })

  assert.equal(customEvents.enabled, true)
  assert.equal(customEvents.channel, 'site')
  assert.equal(customEvents.eventName, 'Schedule')
  assert.equal(customEvents.parameters.currency, 'MXN')
  assert.match(html, /window\.ristakMetaTrackCalendarEvent/)
  assert.match(html, /meta: getMetaEventPayload\(\)/)
  assert.match(html, /trackCalendarMetaEvent\(payload\.data\?\.metaEvent\)/)
})

test('public calendar keeps smart custom Meta events eligible for Pixel tracking', () => {
  const customEvents = normalizeCalendarCustomEventsConfig({
    enabled: true,
    channel: 'smart',
    eventName: 'Schedule',
    parameters: {
      value: '1500',
      predictedLtv: '5000'
    }
  })
  const html = renderPublicCalendarHtml({
    id: 'calendar-meta-smart',
    slug: 'agenda-inteligente',
    name: 'Agenda inteligente',
    customEvents
  }, {
    metaPixelSnippet: '<script>window.ristakMetaTrackCalendarEvent=function(){}</script>'
  })

  assert.equal(customEvents.enabled, true)
  assert.equal(customEvents.channel, 'smart')
  assert.equal(customEvents.eventName, 'Schedule')
  assert.equal(customEvents.parameters.value, '1500')
  assert.equal(customEvents.parameters.predictedLtv, '5000')
  assert.match(html, /window\.ristakMetaTrackCalendarEvent/)
  assert.match(html, /trackCalendarMetaEvent\(payload\.data\?\.metaEvent\)/)
})

test('public calendar normalizes WhatsApp custom appointment event as LeadSubmitted', () => {
  const customEvents = normalizeCalendarCustomEventsConfig({
    enabled: true,
    channel: 'whatsapp',
    eventName: 'Schedule'
  })

  assert.deepEqual(customEvents, {
    enabled: true,
    channel: 'whatsapp',
    eventName: 'LeadSubmitted',
    parameters: {}
  })
})

test('calendar embed bridges to a redirect URL on booking', async () => {
  const html = await renderPublicSiteHtml(calendarSite({
    calendarCompletionAction: 'redirect',
    calendarCompletionRedirectUrl: 'https://example.test/gracias-cita'
  }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-rstk-calendar-redirect="https:\/\/example\.test\/gracias-cita"/)
  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('bookingBridge'), '1')
})

test('calendar embed bridges to the next funnel page on booking', async () => {
  const site = calendarSite({ calendarCompletionAction: 'next_page' })
  site.theme.pages = [
    { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
    { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
  ]
  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-rstk-calendar-redirect="[^"]*page-2[^"]*"/)
  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('bookingBridge'), '1')
})

test('calendar embed uses its own rules by default (no bridge)', async () => {
  const html = await renderPublicSiteHtml(calendarSite(), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.doesNotMatch(html, /data-rstk-calendar-redirect=/)
  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('bookingBridge'), null)
})
