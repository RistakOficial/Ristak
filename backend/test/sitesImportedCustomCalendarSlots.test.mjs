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

function runtimeScriptFromHtml(html) {
  const markerIndex = html.indexOf('window.ristakCalendarGetSlots')
  assert.notEqual(markerIndex, -1, 'el sitio debe incluir el runtime del calendario personalizado')
  const scriptStart = html.lastIndexOf('<script>', markerIndex)
  const scriptEnd = html.indexOf('</script>', markerIndex)
  assert.notEqual(scriptStart, -1)
  assert.notEqual(scriptEnd, -1)
  return html.slice(scriptStart + '<script>'.length, scriptEnd)
}

function createRuntimeHarness(script, initialPayload, selectedDate = '2030-01-08') {
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
      origin: 'https://example.test',
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

function createAdvancedRuntimeHarness(script, initialPayload) {
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
  const bookingForm = eventNode()
  const formNodes = new Map([
    ['[type="submit"]', submit],
    ['[data-rstk-calendar-name]', name],
    ['[data-rstk-calendar-email]', email],
    ['[data-rstk-calendar-phone]', phone],
    ['[data-rstk-calendar-notes]', notes]
  ])
  bookingForm.querySelector = selector => formNodes.get(selector) || null

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
    ['[data-rstk-calendar-timezone-label]', []],
    ['[data-rstk-calendar-back-to-dates]', []],
    ['[data-rstk-calendar-back-to-times]', []]
  ])
  const root = eventNode({ dataset: {} })
  root.getAttribute = name => name === 'data-rstk-native-slot-id' ? 'agenda-custom' : ''
  root.querySelector = selector => nodes.get(selector) || null
  root.querySelectorAll = selector => nodeLists.get(selector) || []

  const requestedUrls = []
  const appointmentBodies = []
  const window = {
    location: {
      origin: 'https://example.test',
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
    fetch: async (url, options = {}) => {
      requestedUrls.push(String(url))
      if (String(url).endsWith('/appointments')) {
        appointmentBodies.push(JSON.parse(options.body || '{}'))
        return {
          ok: true,
          json: async () => ({ success: true, data: { message: 'Confirmación avanzada' } })
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
    message,
    monthLabel,
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
    ])

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

    await createBlock(siteId, {
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

    const nowParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    const slot = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, 15, 3, 0)).toISOString()
    const slotDate = `${nowParts.year}-${nowParts.month}-15`

    const site = await getSite(siteId, { includeBlocks: true })
    const html = await renderPublicSiteHtml(site, { pageId: 'page-1', trackingEnabled: false, preview: true })
    const harness = createAdvancedRuntimeHarness(runtimeScriptFromHtml(html), [
      { date: 'dato-no-confiable', slots: [slot] }
    ])
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

    assert.deepEqual(harness.appointmentBodies[0], {
      startTime: slot,
      timezone: 'Asia/Tokyo',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: '+525511223344',
      notes: 'Primera consulta'
    })
    assert.equal(harness.stepForm.hidden, true)
    assert.equal(harness.stepSuccess.hidden, false)
    assert.equal(harness.success.textContent, 'Confirmación avanzada')
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
