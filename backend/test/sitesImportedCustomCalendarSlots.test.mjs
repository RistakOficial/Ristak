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
