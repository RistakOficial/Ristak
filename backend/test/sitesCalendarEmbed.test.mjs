import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getCalendarBookingFormDefinition,
  normalizeCalendarBookingCompletionConfig,
  normalizeCalendarCustomEventsConfig,
  renderPublicCalendarHtml
} from '../src/services/localCalendarService.js'
import { createBlock, createSite, deleteSite, renderPublicSiteHtml } from '../src/services/sitesService.js'

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

function findCalendarBlock(site, slug) {
  return site.blocks.find(block => block.blockType === 'calendar_embed' && block.settings?.calendarSlug === slug)
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
    calendarWidgetTheme: 'agenda',
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
  assert.equal(url.searchParams.get('widgetTheme'), 'agenda')
  assert.equal(url.searchParams.get('accent'), '#ff0055')
  assert.equal(url.searchParams.get('slotRadius'), '18')
  assert.equal(url.searchParams.get('fieldRadius'), '12')
})

test('site calendar embed forwards per-block Meta event and parameters', async () => {
  const site = calendarSite()
  site.metaCapiEnabled = true
  site.theme.metaCalendarEvents = {
    'calendar-block': {
      enabled: true,
      eventName: 'Schedule',
      eventParameters: {
        value: '1500',
        currency: 'mxn',
        status: 'qualified',
        contentName: 'No viaja en Schedule',
        custom: [{ key: 'pipeline_stage', value: 'demo' }]
      }
    }
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: true,
    preview: false
  })

  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('metaCalEvent'), 'Schedule')
  assert.deepEqual(JSON.parse(url.searchParams.get('metaCalData')), {
    value: '1500',
    currency: 'MXN',
    status: 'qualified',
    custom: [{ id: '', key: 'pipeline_stage', value: 'demo' }]
  })
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
  assert.equal(url.searchParams.get('widgetTheme'), null)
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

test('public calendar renders configured widget themes and per-embed theme overrides', () => {
  const calendar = {
    id: 'calendar-widget-theme',
    slug: 'agenda-widget-theme',
    name: 'Agenda widget theme',
    slotDuration: 30,
    eventColor: '#146FC5',
    bookingDisplay: { widgetTheme: 'night' }
  }

  const configuredTheme = renderPublicCalendarHtml(calendar, { embedded: true })
  assert.match(configuredTheme, /rstk-calendar-theme-night/)
  assert.match(configuredTheme, /body\.rstk-calendar-theme-night \.shell/)

  const customTheme = renderPublicCalendarHtml(calendar, {
    embedded: true,
    style: { designMode: 'custom', widgetTheme: 'minimal' }
  })
  assert.match(customTheme, /rstk-calendar-theme-minimal/)

  const invalidTheme = renderPublicCalendarHtml({
    ...calendar,
    bookingDisplay: { widgetTheme: 'space-laser' }
  }, { embedded: true })
  assert.match(invalidTheme, /rstk-calendar-theme-ristak/)

  const agendaTheme = renderPublicCalendarHtml({
    ...calendar,
    bookingDisplay: { widgetTheme: 'agenda' }
  }, { embedded: true })
  assert.match(agendaTheme, /body\.rstk-calendar-theme-agenda \.day\{width:50px;height:50px/)
  assert.ok(agendaTheme.includes('.day,body.rstk-calendar-theme-agenda .day{width:40px;height:40px;max-width:100%}'))
  assert.ok(agendaTheme.includes('.day,body.rstk-calendar-theme-agenda .day{width:38px;height:38px;max-width:100%}'))
})

test('public calendar asks for timezone after date selection when visitor timezone is enabled', () => {
  const calendar = {
    id: 'calendar-timezone-step',
    slug: 'agenda-timezone-step',
    name: 'Agenda timezone',
    slotDuration: 30,
    eventColor: '#146FC5'
  }

  const selectableTimezone = renderPublicCalendarHtml(calendar)
  assert.match(selectableTimezone, /<div class="timezone" data-calendar-timezone hidden>/)
  assert.match(selectableTimezone, /<div class="timezone timezoneStep" data-timezone-step hidden>/)
  assert.match(selectableTimezone, /\.timezone\[hidden\]\{display:none\}/)
  assert.match(selectableTimezone, /\.timezoneStep\{display:grid;justify-items:center;text-align:center;gap:8px;padding:12px 0 2px\}/)
  assert.match(selectableTimezone, /\.timezoneStep \.timezoneControl\{width:min\(320px,100%\);justify-items:center\}/)
  assert.match(selectableTimezone, /\.timezoneStep \.timezoneControl select\{width:100%;max-width:280px\}/)
  assert.match(selectableTimezone, /\.timezoneStep \.timezoneControl select\{appearance:none;-webkit-appearance:none;padding-right:42px;line-height:1\.2;background-image:linear-gradient\(45deg,transparent 50%,var\(--field-text\) 50%\),linear-gradient\(135deg,var\(--field-text\) 50%,transparent 50%\);background-position:calc\(100% - 16px\) calc\(50% - 2px\),calc\(100% - 11px\) calc\(50% - 2px\);background-size:5px 5px,5px 5px;background-repeat:no-repeat\}/)
  assert.match(selectableTimezone, /<span>Confirma tu zona horaria<\/span>/)
  assert.match(selectableTimezone, /<select data-timezone-select aria-label="Confirmar zona horaria"><\/select>/)
  assert.match(selectableTimezone, /const setTimezoneConfirmationVisible = \(visible\) => \{\s*if \(timezoneStep\) timezoneStep\.hidden = !visible;\s*\};/)
  assert.match(selectableTimezone, /if \(step !== 'slots'\) setTimezoneConfirmationVisible\(false\);/)
  assert.match(selectableTimezone, /setTimezoneConfirmationVisible\(\!\!key\);/)
  assert.match(selectableTimezone, /selectedSubtitle\.textContent = formatDay\(selectedSlot\) \+ ' a las ' \+ formatTime\(selectedSlot\) \+ ' \| Zona horaria: ' \+ timezone;/)
  assert.ok(
    selectableTimezone.indexOf('data-selected-subtitle') < selectableTimezone.indexOf('data-timezone-step') &&
      selectableTimezone.indexOf('data-timezone-step') < selectableTimezone.indexOf('data-slots'),
    'timezone confirmation should render between the selected date summary and available times'
  )

  const fixedTimezone = renderPublicCalendarHtml({
    ...calendar,
    bookingDisplay: { allowTimezoneSelection: false }
  })
  assert.doesNotMatch(fixedTimezone, /Confirma tu zona horaria/)
  assert.doesNotMatch(fixedTimezone, /<div class="timezone timezoneStep"/)
  assert.match(fixedTimezone, /<div class="timezone" data-calendar-timezone>/)
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
  assert.match(html, /window\.location\.assign\(appendContactPrefillParams\(completionRedirectUrl\)\)/)
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
  assert.match(html, /\.shell\.bookingActive,\.shell\.formGate\{width:min\(100%,640px\);min-height:0;grid-template-columns:minmax\(0,1fr\)/)
  assert.match(html, /\.shell\.bookingActive \.intro,\.shell\.formGate \.intro,\.shell\.bookingActive \.calendarPane,\.shell\.formGate \.calendarPane\{display:none\}/)
  assert.match(html, /\.shell\.bookingActive form,\.shell\.formGate form\{border-top:0;padding-top:0;gap:13px\}/)
  assert.match(html, /data-change-label>Cambiar fecha<\/span>/)
  assert.match(html, /Cambiar fecha y hora/)
})

test('public embedded calendar reports its content height to avoid inner scrollbars', () => {
  const html = renderPublicCalendarHtml({
    id: 'calendar-height-bridge',
    slug: 'agenda-height-bridge',
    name: 'Agenda height bridge',
    slotDuration: 30,
    eventColor: '#146FC5'
  }, { embedded: true })

  assert.match(html, /const isEmbeddedCalendar = document\.body\.classList\.contains\('rstk-calendar-embedded'\)/)
  assert.match(html, /window\.parent\.postMessage\(\{ type: 'ristak:calendar-embed-height', height: height \+ 2 \}, '\*'\)/)
  assert.match(html, /body\.rstk-calendar-embedded \.page\{min-height:0;width:100%;padding:0;place-items:stretch\}/)
  assert.match(html, /body\.rstk-calendar-embedded \.shell\.bookingActive,body\.rstk-calendar-embedded \.shell\.formGate\{min-height:0\}/)
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
          id: 'intro-video',
          blockType: 'video',
          isContent: true,
          label: '',
          content: '',
          settings: { mediaUrl: '/media/vertical-intro.mp4' },
          pageId: 'screen-1',
          sortOrder: 1
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
  assert.match(html, /\.shell\.formGate \.selectedDate,\.shell\.formGate \.changeSlot\{display:none\}/)
  assert.match(html, /\.shell\.formGate form\{border-top:0;padding-top:0;gap:14px\}/)
  assert.match(html, /\.calContentVideo video\{display:block;width:auto;max-width:100%;height:auto;max-height:min\(52vh,560px\);object-fit:contain\}/)
  assert.match(html, /\.shell\.formGate \.calContentVideo video\{max-height:min\(48vh,520px\)\}/)
  assert.match(html, /<div class="formHeader" data-form-header="minimal">/)
  assert.match(html, /data-form-progress aria-live="polite">Pantalla 1 de 2<\/p>/)
  assert.ok(html.includes('.formHeader [data-form-progress]{display:inline-flex;align-items:center;justify-content:center;min-height:28px;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line));border-radius:999px;background:var(--accent-soft);color:var(--accent);padding:4px 10px;font-size:.74rem;font-weight:600;line-height:1;letter-spacing:.04em;text-transform:uppercase}'))
  assert.doesNotMatch(html, /<h2>Solicitud<\/h2>/)
  assert.doesNotMatch(html, /<h3>Bienvenida<\/h3>/)
  assert.doesNotMatch(html, /<h3>Datos<\/h3>/)
  assert.match(html, /<div class="formPage" data-form-page="screen-1">/)
  assert.match(html, /<div class="formPage" data-form-page="screen-2" hidden>/)
  assert.match(html, /<div class="calContentVideo"><video src="\/media\/vertical-intro\.mp4" controls playsinline preload="metadata"><\/video><\/div>/)
  assert.match(html, /<button class="submit" type="button" data-form-next>Siguiente<\/button>/)
  assert.match(html, /<button class="submit" type="submit" hidden disabled data-submit>Selecciona un horario<\/button>/)
  assert.match(html, /const validateAllPages = \(\) => validatePagesThrough\(formPages\.length - 1\);/)
  assert.match(html, /if \(submit\) \{ submit\.disabled = false; submit\.textContent = 'Continuar'; \}/)
  assert.doesNotMatch(html, /submit\.disabled = immediateDisqualified/)
  assert.match(html, /if \(formFirst && gatePassed && submit\) submit\.hidden = false;/)
})

test('public calendar custom form keeps result pages out of the question flow', async () => {
  const site = await createSite({
    siteType: 'interactive_form',
    name: 'Solicitud artista',
    slug: 'calendar-result-pages-test',
    blankCanvas: true,
    theme: {
      pages: [
        { id: 'page-1', title: 'Bienvenida', sortOrder: 0 },
        { id: 'page-2', title: 'Calificado', sortOrder: 1 },
        { id: 'page-3', title: 'No candidato', sortOrder: 2 }
      ],
      formDisqualifiedMessage: 'Gracias por responder.'
    }
  })

  try {
    await createBlock(site.id, {
      blockType: 'title',
      content: 'Pregunta real del formulario',
      settings: { pageId: 'page-1' }
    })
    await createBlock(site.id, {
      blockType: 'radio',
      label: 'Eres artista?',
      required: true,
      options: [
        { label: 'Si', value: 'si' },
        { label: 'No', value: 'no', action: 'disqualify' }
      ],
      settings: { pageId: 'page-1' }
    })
    await createBlock(site.id, {
      blockType: 'title',
      content: 'Tu solicitud fue aprobada',
      settings: { pageId: 'page-2' }
    })
    await createBlock(site.id, {
      blockType: 'text',
      content: 'Por ahora no parece ser el siguiente paso ideal.',
      settings: { pageId: 'page-3' }
    })

    const definition = await getCalendarBookingFormDefinition({
      bookingForm: {
        useCustomForm: true,
        customFormId: site.id
      }
    })

    assert.deepEqual(definition.pages.map(page => page.id), ['page-1'])
    assert.ok(definition.fields.some(field => field.content === 'Pregunta real del formulario'))
    assert.ok(definition.fields.some(field => field.label === 'Eres artista?'))
    assert.equal(definition.fields.some(field => field.content === 'Tu solicitud fue aprobada'), false)
    assert.equal(definition.fields.some(field => field.content === 'Por ahora no parece ser el siguiente paso ideal.'), false)
    assert.match(definition.disqualification.html, /Por ahora no parece ser el siguiente paso ideal\./)
    assert.doesNotMatch(definition.disqualification.html, /Tu solicitud fue aprobada/)

    const html = renderPublicCalendarHtml({
      id: 'calendar-result-pages',
      slug: 'agenda-result-pages',
      name: 'Agenda con resultado',
      slotDuration: 30,
      eventColor: '#146FC5',
      bookingDisplay: { formPosition: 'before' }
    }, { bookingForm: definition })

    const pageOneMatch = html.match(/<div class="formPage" data-form-page="page-1">([\s\S]*?)<\/div>\s*<div class="formActions">/)
    assert.ok(pageOneMatch, 'page-1 should render as the only question page')
    assert.match(pageOneMatch[1], /Pregunta real del formulario/)
    assert.doesNotMatch(pageOneMatch[1], /Tu solicitud fue aprobada/)
    assert.doesNotMatch(pageOneMatch[1], /Por ahora no parece ser el siguiente paso ideal\./)
    assert.match(html, /data-success-content hidden/)
    assert.match(html, /payload\.html \|\| fallbackContent\.html/)
  } finally {
    await deleteSite(site.id)
  }
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
  assert.match(html, /<iframe class="rstk-embed rstk-calendar-embed"[^>]+scrolling="no"/)
  const url = getCalendarFrameUrl(html)
  assert.equal(url.searchParams.get('bookingBridge'), '1')
})

test('site calendar embed resizes when the calendar posts its content height', async () => {
  const html = await renderPublicSiteHtml(calendarSite(), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data\.type === 'ristak:calendar-embed-height'/)
  assert.match(html, /document\.querySelectorAll\('iframe\.rstk-calendar-embed'\)/)
  assert.match(html, /calendarFrame\.style\.minHeight = Math\.round\(height\) \+ 'px'/)
  assert.match(html, /calendarFrame\.style\.height = Math\.round\(height\) \+ 'px'/)
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

test('calendar embeds created on funnel landings default to next page on booking', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Agenda funnel default',
    slug: 'agenda-funnel-default',
    blankCanvas: true,
    theme: {
      pageMode: 'funnel',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Calendario',
      settings: {
        pageId: 'page-1',
        calendarSlug: 'agenda-funnel-default',
        calendarName: 'Agenda funnel default'
      }
    })

    const block = findCalendarBlock(updated, 'agenda-funnel-default')
    assert.equal(block?.settings?.calendarCompletionAction, 'next_page')

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /data-rstk-calendar-redirect="[^"]*page-2[^"]*"/)
    const url = getCalendarFrameUrl(html)
    assert.equal(url.searchParams.get('bookingBridge'), '1')
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('calendar embed creation preserves explicit calendar completion rules', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Agenda explicit default',
    slug: 'agenda-explicit-default',
    blankCanvas: true,
    theme: {
      pageMode: 'funnel',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Calendario',
      settings: {
        pageId: 'page-1',
        calendarSlug: 'agenda-explicit-default',
        calendarName: 'Agenda explicit default',
        calendarCompletionAction: 'calendar_default'
      }
    })

    const block = findCalendarBlock(updated, 'agenda-explicit-default')
    assert.equal(block?.settings?.calendarCompletionAction, 'calendar_default')

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.doesNotMatch(html, /data-rstk-calendar-redirect=/)
    const url = getCalendarFrameUrl(html)
    assert.equal(url.searchParams.get('bookingBridge'), null)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('calendar embeds created on website landings keep calendar rules by default', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Agenda website default',
    slug: 'agenda-website-default',
    blankCanvas: true,
    theme: {
      pageMode: 'website',
      pages: [
        { id: 'page-1', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
        { id: 'page-2', title: 'Gracias', slug: 'gracias', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'calendar_embed',
      label: 'Calendario',
      settings: {
        pageId: 'page-1',
        calendarSlug: 'agenda-website-default',
        calendarName: 'Agenda website default'
      }
    })

    const block = findCalendarBlock(updated, 'agenda-website-default')
    assert.equal(block?.settings?.calendarCompletionAction, undefined)

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.doesNotMatch(html, /data-rstk-calendar-redirect=/)
    const url = getCalendarFrameUrl(html)
    assert.equal(url.searchParams.get('bookingBridge'), null)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
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
