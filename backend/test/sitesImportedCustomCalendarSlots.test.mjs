import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import {
  createBlock,
  createImportedSiteFromHtml,
  deleteSite,
  getSite,
  renderPublicSiteHtml
} from '../src/services/sitesService.js'
import { normalizeCalendarBookingSubmission } from '../src/services/localCalendarService.js'

function runtimeScriptFromHtml(html) {
  const markerIndex = html.indexOf('window.ristakCalendarGetSlots')
  assert.notEqual(markerIndex, -1, 'el sitio debe incluir el runtime del calendario personalizado')
  const scriptStart = html.lastIndexOf('<script>', markerIndex)
  const scriptEnd = html.indexOf('</script>', markerIndex)
  assert.notEqual(scriptStart, -1)
  assert.notEqual(scriptEnd, -1)
  return html.slice(scriptStart + '<script>'.length, scriptEnd)
}

function createRuntimeHarness(script, initialPayload, selectedDate = '2030-01-08', options = {}) {
  const dateInput = {
    value: selectedDate,
    addEventListener() {}
  }
  const endDateInput = { value: selectedDate }
  const slotsField = { innerHTML: '', value: '' }
  const message = {
    textContent: '',
    status: '',
    setAttribute(name, value) {
      if (name === 'data-status') this.status = value
    }
  }
  let loadSlotsHandler = null
  const loadButton = {
    disabled: false,
    addEventListener(name, handler) {
      if (name === 'click') loadSlotsHandler = handler
    }
  }
  const nodes = new Map([
    ['[data-rstk-calendar-date]', dateInput],
    ['[data-rstk-calendar-end-date]', endDateInput],
    ['[data-rstk-calendar-time]', slotsField],
    ['[data-rstk-calendar-load-slots]', loadButton],
    ['[data-rstk-calendar-message]', message]
  ])
  const root = {
    dataset: {},
    getAttribute(name) {
      return name === 'data-rstk-native-slot-id' ? 'agenda-custom' : ''
    },
    querySelector(selector) {
      return nodes.get(selector) || null
    }
  }
  let payload = initialPayload
  const requestedUrls = []
  const window = {
    location: {
      origin: options.locationOrigin ?? 'https://example.test',
      href: options.locationHref ?? 'https://example.test/agenda',
      assign() {}
    },
    dispatchEvent() {}
  }
  const document = {
    readyState: 'complete',
    querySelectorAll(selector) {
      return selector.includes('rstk-imported-native-custom') ? [root] : []
    },
    addEventListener() {}
  }

  runInNewContext(script, {
    URL,
    CustomEvent: class CustomEvent {},
    document,
    window,
    fetch: async (url) => {
      requestedUrls.push(String(url))
      return {
        ok: true,
        json: async () => ({ success: true, data: payload })
      }
    }
  })

  return {
    dateInput,
    endDateInput,
    message,
    requestedUrls,
    slotsField,
    setPayload(nextPayload) {
      payload = nextPayload
    },
    async loadSlots() {
      assert.equal(typeof loadSlotsHandler, 'function')
      loadSlotsHandler({ preventDefault() {} })
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

function createAdvancedRuntimeHarness(script, initialPayload, harnessOptions = {}) {
  const eventNode = (initial = {}) => {
    const handlers = new Map()
    const attributes = new Map()
    return {
      disabled: false,
      hidden: false,
      innerHTML: '',
      textContent: '',
      ...initial,
      addEventListener(name, handler) {
        handlers.set(name, handler)
      },
      getAttribute(name) {
        return attributes.get(name) || ''
      },
      setAttribute(name, value) {
        attributes.set(name, String(value))
      },
      removeAttribute(name) {
        attributes.delete(name)
      },
      async trigger(name, event = { preventDefault() {} }) {
        const handler = handlers.get(name)
        assert.equal(typeof handler, 'function', `falta listener ${name}`)
        return handler(event)
      }
    }
  }

  const monthLabel = eventNode()
  const previousMonth = eventNode()
  const nextMonth = eventNode()
  const days = eventNode()
  const slots = eventNode()
  const message = eventNode()
  const success = eventNode()
  const selectedDateLabel = eventNode()
  const selectedTimeLabel = eventNode()
  const selectedDateTimeLabel = eventNode()
  const stepDate = eventNode()
  const stepTime = eventNode()
  const stepForm = eventNode()
  const stepSuccess = eventNode()
  stepDate.setAttribute('data-rstk-calendar-step', 'date')
  stepTime.setAttribute('data-rstk-calendar-step', 'time')
  stepForm.setAttribute('data-rstk-calendar-step', 'form')
  stepSuccess.setAttribute('data-rstk-calendar-step', 'success')

  const submit = eventNode()
  const name = eventNode({ value: 'Ada Lovelace' })
  const email = eventNode({ value: 'ada@example.test' })
  const phone = eventNode({ value: '+525511223344' })
  const notes = eventNode({ value: 'Primera consulta' })
  name.tagName = 'INPUT'
  email.tagName = 'INPUT'
  phone.tagName = 'INPUT'
  notes.tagName = 'TEXTAREA'
  if (harnessOptions.includeResponses) {
    name.setAttribute('data-rstk-calendar-response', 'nombre')
    name.setAttribute('data-rstk-label', 'Nombre')
    email.setAttribute('data-rstk-calendar-response', 'correo')
    email.setAttribute('data-rstk-label', 'Correo')
    notes.setAttribute('data-rstk-calendar-response', 'motivo')
    notes.setAttribute('data-rstk-label', 'Motivo de la consulta')
  }
  const bookingForm = eventNode()
  const formNodes = new Map([
    ['[type="submit"]', submit],
    ['[data-rstk-calendar-name]', name],
    ['[data-rstk-calendar-email]', email],
    ['[data-rstk-calendar-phone]', phone],
    ['[data-rstk-calendar-notes]', notes]
  ])
  bookingForm.querySelector = selector => formNodes.get(selector) || null
  bookingForm.querySelectorAll = selector => selector === 'input, select, textarea'
    ? [name, email, phone, notes]
    : []

  const flowKinds = Array.isArray(harnessOptions.flowKinds) ? harnessOptions.flowKinds : []
  const flowSteps = flowKinds.map((kind, index) => {
    const step = eventNode()
    step.setAttribute('data-rstk-calendar-flow-step', `${kind}-${index + 1}`)
    step.setAttribute('data-rstk-calendar-flow-kind', kind)
    step.querySelectorAll = selector => (
      selector === 'input, select, textarea' && kind === 'questions'
        ? [name, email, notes]
        : []
    )
    return step
  })
  const flowNextButtons = flowKinds
    .map((kind, index) => ({ kind, index }))
    .filter(item => item.kind === 'questions')
    .map(() => eventNode())
  const flowBackButtons = flowKinds
    .map((kind, index) => ({ kind, index }))
    .filter(item => item.index > 0 && item.kind !== 'success')
    .map(() => eventNode())

  const nodes = new Map([
    ['[data-rstk-calendar-month-label]', monthLabel],
    ['[data-rstk-calendar-prev-month]', previousMonth],
    ['[data-rstk-calendar-next-month]', nextMonth],
    ['[data-rstk-calendar-days]', days],
    ['[data-rstk-calendar-slots]', slots],
    ['[data-rstk-calendar-book-form]', bookingForm],
    ['[data-rstk-calendar-message]', message],
    ['[data-rstk-calendar-success]', success]
  ])
  const nodeLists = new Map([
    ['[data-rstk-calendar-selected-date]', [selectedDateLabel]],
    ['[data-rstk-calendar-selected-time]', [selectedTimeLabel]],
    ['[data-rstk-calendar-selected-datetime]', [selectedDateTimeLabel]],
    ['[data-rstk-calendar-step]', [stepDate, stepTime, stepForm, stepSuccess]],
    ['[data-rstk-calendar-flow-step]', flowSteps],
    ['[data-rstk-calendar-flow-next]', flowNextButtons],
    ['[data-rstk-calendar-flow-back]', flowBackButtons],
    ['[data-rstk-calendar-timezone-label]', []],
    ['[data-rstk-calendar-back-to-dates]', []],
    ['[data-rstk-calendar-back-to-times]', []]
  ])
  const root = eventNode({ dataset: {} })
  root.getAttribute = name => name === 'data-rstk-native-slot-id' ? (harnessOptions.slotId || 'agenda-custom') : ''
  root.querySelector = selector => nodes.get(selector) || null
  root.querySelectorAll = selector => nodeLists.get(selector) || []

  const requestedUrls = []
  const appointmentBodies = []
  const pixelEvents = []
  const window = {
    location: {
      origin: harnessOptions.locationOrigin ?? 'https://example.test',
      href: harnessOptions.locationHref ?? 'https://example.test/agenda',
      assign() {}
    },
    dispatchEvent() {},
    ristakMetaBuildMetaPayload(meta = {}) {
      return { visitorId: 'visitor-calendar-1', fbp: 'fbp-calendar-1', ...meta }
    },
    ristakMetaTrackSiteEvent(eventName, eventId, customData) {
      pixelEvents.push({ eventName, eventId, customData })
    }
  }
  const document = {
    readyState: 'complete',
    querySelectorAll(selector) {
      return selector.includes('rstk-imported-native-custom') ? [root] : []
    },
    addEventListener() {}
  }

  runInNewContext(script, {
    URL,
    CustomEvent: class CustomEvent {},
    document,
    window,
    fetch: async (url, fetchOptions = {}) => {
      requestedUrls.push(String(url))
      if (String(url).endsWith('/appointments')) {
        appointmentBodies.push(JSON.parse(fetchOptions.body || '{}'))
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: harnessOptions.appointmentData || {
              message: 'Confirmación avanzada',
              metaEvent: {
                eventName: 'Schedule',
                eventId: 'schedule-event-1',
                appointmentId: 'appointment-1',
                status: 'booked'
              }
            }
          })
        }
      }
      return {
        ok: true,
        json: async () => ({ success: true, data: initialPayload })
      }
    }
  })

  return {
    appointmentBodies,
    bookingForm,
    days,
    flowBackButtons,
    flowNextButtons,
    flowSteps,
    message,
    monthLabel,
    pixelEvents,
    requestedUrls,
    selectedDateLabel,
    selectedDateTimeLabel,
    selectedTimeLabel,
    slots,
    stepDate,
    stepForm,
    stepSuccess,
    stepTime,
    success,
    async settle() {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

test('respuestas HTML propias acompañan la cita sin convertir el calendario en formulario', () => {
  const normalized = normalizeCalendarBookingSubmission({
    formId: 'calendar_default',
    formName: 'Agenda',
    fields: [
      { id: 'calendar_name', label: 'Nombre', required: true, settings: { systemFieldKey: 'full_name' } },
      { id: 'calendar_email', label: 'Correo', required: true, settings: { systemFieldKey: 'email', validation: 'email' } }
    ]
  }, {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    responses: {
      motivo: 'Quiero una estrategia comercial',
      prioridad: ['Esta semana', 'Presupuesto aprobado']
    },
    responseLabels: {
      motivo: 'Motivo de la consulta',
      prioridad: 'Prioridad'
    }
  })

  assert.deepEqual(normalized.errors, [])
  assert.deepEqual(normalized.responses, {
    calendar_name: 'Ada Lovelace',
    calendar_email: 'ada@example.test',
    motivo: 'Quiero una estrategia comercial',
    prioridad: ['Esta semana', 'Presupuesto aprobado']
  })
  assert.match(normalized.responseSummary, /Motivo de la consulta: Quiero una estrategia comercial/)
  assert.match(normalized.responseSummary, /Prioridad: Esta semana, Presupuesto aprobado/)
})

test('calendario HTML personalizado usa la fecha del visitante y conserva listas planas', async () => {
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'calendar-custom-slots.html',
      fileBase64: Buffer.from(`
        <!doctype html>
        <html>
          <body>
            <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-custom" data-rstk-native-render="custom">
              <input type="date" data-rstk-calendar-date>
              <button type="button" data-rstk-calendar-load-slots>Ver horarios</button>
              <select data-rstk-calendar-time></select>
              <p data-rstk-calendar-message></p>
            </section>
          </body>
        </html>
      `, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `HTML custom slot groups ${Date.now()}`
    })
    siteId = created.site.id

    await createBlock(siteId, {
      blockType: 'calendar_embed',
      label: 'Agenda custom',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-custom',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'custom',
        calendarId: 'cal-custom-slots',
        calendarSlug: 'agenda-custom-slots',
        calendarName: 'Agenda personalizada',
        calendarTimezone: 'Asia/Tokyo'
      }
    })

    const site = await getSite(siteId, { includeBlocks: true })
    const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
    const harness = createRuntimeHarness(runtimeScriptFromHtml(html), [
      { date: '2030-01-07', slots: ['2030-01-07T03:00:00.000Z'] },
      { date: '2030-01-08', slots: ['2030-01-08T03:00:00.000Z', '2030-01-08T04:00:00.000Z'] }
    ], '2030-01-08', { locationOrigin: 'null', locationHref: 'about:srcdoc' })

    await harness.loadSlots()

    assert.match(harness.requestedUrls[0], /startDate=2030-01-08/)
    assert.match(harness.slotsField.innerHTML, /value="2030-01-08T03:00:00.000Z"/)
    assert.match(harness.slotsField.innerHTML, /value="2030-01-08T04:00:00.000Z"/)
    assert.doesNotMatch(harness.slotsField.innerHTML, /2030-01-07T03:00:00.000Z/)
    assert.equal(harness.message.textContent, '')

    harness.setPayload([
      { startTime: '2030-01-08T20:00:00.000Z', label: '2:00 p. m.' }
    ])
    await harness.loadSlots()

    assert.match(harness.slotsField.innerHTML, /value="2030-01-08T20:00:00.000Z"/)
    assert.match(harness.slotsField.innerHTML, />2:00 p. m.<\/option>/)

    harness.setPayload(['2030-01-08T21:00:00.000Z'])
    await harness.loadSlots()

    assert.match(harness.slotsField.innerHTML, /value="2030-01-08T21:00:00.000Z"/)

    // En Ciudad Juárez este instante todavía es martes 8 (20:00); en Tokio,
    // la zona configurada para el visitante, ya es miércoles 9 (12:00).
    // El runtime debe mirar el ISO y no confiar en day.date del negocio.
    harness.dateInput.value = '2030-01-09'
    harness.endDateInput.value = '2030-01-09'
    harness.setPayload([
      { date: '2030-01-08', slots: ['2030-01-09T03:00:00.000Z'] },
      { date: '2030-01-09', slots: ['2030-01-09T16:00:00.000Z'] }
    ])
    await harness.loadSlots()

    assert.match(harness.requestedUrls.at(-1), /startDate=2030-01-09/)
    assert.match(harness.requestedUrls.at(-1), /timezone=Asia%2FTokyo/)
    assert.match(harness.slotsField.innerHTML, /value="2030-01-09T03:00:00.000Z"/)
    assert.doesNotMatch(harness.slotsField.innerHTML, /2030-01-09T16:00:00.000Z/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('calendario HTML avanzado pinta mes, horarios y formulario con disponibilidad real de Ristak', async () => {
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'calendar-custom-grid.html',
      fileBase64: Buffer.from(`
        <!doctype html>
        <html>
          <body>
            <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-custom" data-rstk-native-render="custom">
              <section data-rstk-calendar-step="date">
                <button type="button" data-rstk-calendar-prev-month>Anterior</button>
                <strong data-rstk-calendar-month-label></strong>
                <button type="button" data-rstk-calendar-next-month>Siguiente</button>
                <div data-rstk-calendar-days></div>
              </section>
              <section data-rstk-calendar-step="time" hidden>
                <h3 data-rstk-calendar-selected-date></h3>
                <div data-rstk-calendar-slots></div>
              </section>
              <section data-rstk-calendar-step="form" hidden>
                <p data-rstk-calendar-selected-time></p>
                <p data-rstk-calendar-selected-datetime></p>
                <form data-rstk-calendar-book-form data-rstk-form-id="agenda-reserva">
                  <input data-rstk-calendar-name data-rstk-field-id="agenda-nombre">
                  <input data-rstk-calendar-email data-rstk-field-id="agenda-email">
                  <input data-rstk-calendar-phone data-rstk-field-id="agenda-telefono">
                  <textarea data-rstk-calendar-notes data-rstk-field-id="agenda-notas"></textarea>
                  <button type="submit">Confirmar</button>
                </form>
              </section>
              <section data-rstk-calendar-step="success" hidden><p data-rstk-calendar-success></p></section>
              <p data-rstk-calendar-message></p>
            </section>
          </body>
        </html>
      `, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `HTML custom calendar grid ${Date.now()}`
    })
    siteId = created.site.id
    assert.equal(created.import.detectedForms.length, 0, 'el formulario interno pertenece al calendario')
    assert.equal(created.import.formMappings.length, 0, 'el calendario no crea un mapping Lead independiente')

    const siteWithCalendar = await createBlock(siteId, {
      blockType: 'calendar_embed',
      label: 'Agenda avanzada',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-custom',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'custom',
        calendarId: 'cal-custom-grid',
        calendarSlug: 'agenda-custom-grid',
        calendarName: 'Agenda avanzada',
        calendarTimezone: 'Asia/Tokyo'
      }
    })
    const calendarBlock = siteWithCalendar.blocks.find(block => (
      block.blockType === 'calendar_embed' && block.settings?.importedHtmlNativeSlotId === 'agenda-custom'
    ))
    assert.ok(calendarBlock)

    const nowParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    const slot = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, 15, 3, 0)).toISOString()
    const slotDate = `${nowParts.year}-${nowParts.month}-15`

    const site = await getSite(siteId, { includeBlocks: true })
    site.metaCapiEnabled = true
    site.theme.metaCalendarEvents = {
      [calendarBlock.id]: {
        enabled: true,
        eventName: 'Schedule',
        eventParameters: { status: 'qualified' }
      }
    }
    const previewHtml = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
    const harness = createAdvancedRuntimeHarness(runtimeScriptFromHtml(previewHtml), [
      { date: 'dato-no-confiable', slots: [slot] }
    ], { locationOrigin: 'null', locationHref: 'about:srcdoc' })
    await harness.settle()

    assert.match(harness.requestedUrls[0], new RegExp(`startDate=${nowParts.year}-${nowParts.month}-01`))
    assert.match(harness.requestedUrls[0], /timezone=Asia%2FTokyo/)
    assert.match(harness.monthLabel.textContent, new RegExp(nowParts.year))
    assert.match(harness.days.innerHTML, new RegExp(`data-date="${slotDate}" data-state="available"`))
    assert.match(harness.days.innerHTML, /data-state="unavailable"[^>]+disabled/)
    assert.equal(harness.message.textContent, '')
    assert.equal(harness.stepDate.hidden, false)
    assert.equal(harness.stepTime.hidden, true)

    const dayButton = {
      disabled: false,
      getAttribute(name) { return name === 'data-date' ? slotDate : '' }
    }
    await harness.days.trigger('click', {
      target: { closest: () => dayButton }
    })

    assert.equal(harness.stepDate.hidden, true)
    assert.equal(harness.stepTime.hidden, false)
    assert.match(harness.selectedDateLabel.textContent, /15/)
    assert.match(harness.slots.innerHTML, new RegExp(`data-start-time="${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))

    const slotButton = {
      getAttribute(name) { return name === 'data-start-time' ? slot : '' }
    }
    await harness.slots.trigger('click', {
      target: { closest: () => slotButton }
    })

    assert.equal(harness.stepTime.hidden, true)
    assert.equal(harness.stepForm.hidden, false)
    assert.match(harness.selectedTimeLabel.textContent, /12:00/)
    assert.match(harness.selectedDateTimeLabel.textContent, /15/)

    await harness.bookingForm.trigger('submit')

    assert.equal(harness.appointmentBodies.length, 0)
    assert.equal(harness.pixelEvents.length, 0)
    assert.equal(harness.stepForm.hidden, true)
    assert.equal(harness.stepSuccess.hidden, false)
    assert.match(harness.success.textContent, /Vista previa: la disponibilidad es real/)

    const liveHtml = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: false })
    const liveHarness = createAdvancedRuntimeHarness(runtimeScriptFromHtml(liveHtml), [
      { date: 'dato-no-confiable', slots: [slot] }
    ], { locationHref: 'https://public.example/agenda?utm_source=meta' })
    await liveHarness.settle()
    await liveHarness.days.trigger('click', {
      target: { closest: () => dayButton }
    })
    await liveHarness.slots.trigger('click', {
      target: { closest: () => slotButton }
    })
    await liveHarness.bookingForm.trigger('submit')

    assert.deepEqual(liveHarness.appointmentBodies[0], {
      startTime: slot,
      timezone: 'Asia/Tokyo',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: '+525511223344',
      notes: 'Primera consulta',
      sourceUrl: 'https://public.example/agenda?utm_source=meta',
      bookingChannel: 'site',
      meta: {
        visitorId: 'visitor-calendar-1',
        fbp: 'fbp-calendar-1',
        conversionType: 'appointment_scheduled',
        siteEventName: 'Schedule',
        siteEventParameters: { status: 'qualified' }
      }
    })
    assert.equal(liveHarness.pixelEvents.length, 1)
    assert.equal(liveHarness.pixelEvents[0].eventName, 'Schedule')
    assert.equal(liveHarness.pixelEvents[0].eventId, 'schedule-event-1')
    assert.equal(liveHarness.stepForm.hidden, true)
    assert.equal(liveHarness.stepSuccess.hidden, false)
    assert.equal(liveHarness.success.textContent, 'Confirmación avanzada')
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('flujo combinado se detecta como calendario aunque las preguntas aparezcan despues del horario', async () => {
  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'calendar-flexible-flow.html',
      fileBase64: Buffer.from(`
        <!doctype html>
        <html>
          <body>
            <section data-rstk-native-element="calendar" data-rstk-native-id="agenda-flexible" data-rstk-native-render="custom">
              <form data-rstk-calendar-book-form>
                <section data-rstk-calendar-flow-step="fecha" data-rstk-calendar-flow-kind="date">
                  <button type="button" data-rstk-calendar-prev-month>Anterior</button>
                  <strong data-rstk-calendar-month-label></strong>
                  <button type="button" data-rstk-calendar-next-month>Siguiente</button>
                  <div data-rstk-calendar-days></div>
                </section>
                <section data-rstk-calendar-flow-step="horario" data-rstk-calendar-flow-kind="time" hidden>
                  <h3 data-rstk-calendar-selected-date></h3>
                  <div data-rstk-calendar-slots></div>
                </section>
                <section data-rstk-calendar-flow-step="preguntas" data-rstk-calendar-flow-kind="questions" hidden>
                  <input name="name" data-rstk-calendar-name data-rstk-calendar-response="nombre" data-rstk-label="Nombre" required>
                  <input name="email" type="email" data-rstk-calendar-email data-rstk-calendar-response="correo" data-rstk-label="Correo" required>
                  <textarea name="motivo" data-rstk-calendar-response="motivo" data-rstk-label="Motivo de la consulta"></textarea>
                  <button type="button" data-rstk-calendar-flow-next>Continuar</button>
                </section>
                <section data-rstk-calendar-flow-step="confirmar" data-rstk-calendar-flow-kind="confirm" hidden>
                  <p data-rstk-calendar-selected-datetime></p>
                  <button type="submit">Agendar</button>
                </section>
                <section data-rstk-calendar-flow-step="listo" data-rstk-calendar-flow-kind="success" hidden>
                  <p data-rstk-calendar-success></p>
                </section>
              </form>
              <p data-rstk-calendar-message></p>
            </section>
          </body>
        </html>
      `, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `HTML flexible calendar ${Date.now()}`
    })
    siteId = created.site.id

    assert.equal(created.import.detectedForms.length, 0, 'el unico submit crea la cita y no es un form independiente')
    assert.equal(created.import.formMappings.length, 0)

    const siteWithCalendar = await createBlock(siteId, {
      blockType: 'calendar_embed',
      label: 'Agenda flexible',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'agenda-flexible',
        importedHtmlNativeType: 'calendar',
        importedHtmlNativeRenderMode: 'custom',
        calendarId: 'cal-flexible',
        calendarSlug: 'agenda-flexible',
        calendarName: 'Agenda flexible',
        calendarTimezone: 'Asia/Tokyo'
      }
    })
    const calendarBlock = siteWithCalendar.blocks.find(block => (
      block.blockType === 'calendar_embed' && block.settings?.importedHtmlNativeSlotId === 'agenda-flexible'
    ))
    assert.ok(calendarBlock)

    const nowParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    const slot = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, 15, 3, 0)).toISOString()
    const slotDate = `${nowParts.year}-${nowParts.month}-15`
    const site = await getSite(siteId, { includeBlocks: true })
    const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: false })
    const harness = createAdvancedRuntimeHarness(runtimeScriptFromHtml(html), [{ slots: [slot] }], {
      locationHref: 'https://public.example/agenda-flexible',
      slotId: 'agenda-flexible',
      flowKinds: ['date', 'time', 'questions', 'confirm', 'success'],
      includeResponses: true
    })
    await harness.settle()

    assert.equal(harness.flowSteps[0].hidden, false)
    assert.equal(harness.flowSteps[1].hidden, true)

    const dayButton = {
      disabled: false,
      getAttribute(name) { return name === 'data-date' ? slotDate : '' }
    }
    await harness.days.trigger('click', { target: { closest: () => dayButton } })
    assert.equal(harness.flowSteps[0].hidden, true)
    assert.equal(harness.flowSteps[1].hidden, false)

    const slotButton = {
      getAttribute(name) { return name === 'data-start-time' ? slot : '' }
    }
    await harness.slots.trigger('click', { target: { closest: () => slotButton } })
    assert.equal(harness.flowSteps[1].hidden, true)
    assert.equal(harness.flowSteps[2].hidden, false)

    await harness.flowNextButtons[0].trigger('click')
    assert.equal(harness.flowSteps[2].hidden, true)
    assert.equal(harness.flowSteps[3].hidden, false)

    await harness.bookingForm.trigger('submit')
    assert.deepEqual(harness.appointmentBodies[0].responses, {
      nombre: 'Ada Lovelace',
      correo: 'ada@example.test',
      motivo: 'Primera consulta'
    })
    assert.deepEqual(harness.appointmentBodies[0].responseLabels, {
      nombre: 'Nombre',
      correo: 'Correo',
      motivo: 'Motivo de la consulta'
    })
    assert.equal(harness.flowSteps[3].hidden, true)
    assert.equal(harness.flowSteps[4].hidden, false)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
