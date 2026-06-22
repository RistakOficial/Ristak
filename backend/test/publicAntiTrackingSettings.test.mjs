import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSite,
  deleteSite,
  updateSite
} from '../src/services/sitesService.js'
import {
  createLocalCalendar,
  deleteLocalCalendar,
  upsertLocalCalendar,
  updateLocalCalendar
} from '../src/services/localCalendarService.js'

const makeSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('public sites default antitracking on and preserve explicit opt-out', async () => {
  const suffix = makeSuffix()
  let site

  try {
    site = await createSite({
      name: 'Antitracking site',
      slug: `antitracking-site-${suffix}`,
      siteType: 'landing_page',
      status: 'draft',
      blankCanvas: true
    })

    assert.equal(site.antiTrackingEnabled, true)

    const disabled = await updateSite(site.id, {
      antiTrackingEnabled: false
    })
    assert.equal(disabled.antiTrackingEnabled, false)

    const preserved = await updateSite(site.id, {
      name: 'Antitracking site renamed'
    })
    assert.equal(preserved.antiTrackingEnabled, false)
  } finally {
    if (site) await deleteSite(site.id).catch(() => undefined)
  }
})

test('public calendars default antitracking on and preserve explicit opt-out', async () => {
  const suffix = makeSuffix()
  const calendarIds = []

  try {
    const calendar = await createLocalCalendar({
      id: `rstk_cal_antitracking_${suffix}`,
      name: 'Antitracking calendar',
      slug: `antitracking-calendar-${suffix}`,
      widgetSlug: `antitracking-calendar-${suffix}`
    })
    calendarIds.push(calendar.id)

    assert.equal(calendar.antiTrackingEnabled, true)

    const disabled = await updateLocalCalendar(calendar.id, {
      antiTrackingEnabled: false
    })
    assert.equal(disabled.antiTrackingEnabled, false)

    const preserved = await upsertLocalCalendar({
      id: calendar.id,
      name: 'Antitracking calendar synced',
      slug: calendar.slug,
      widgetSlug: calendar.widgetSlug
    }, {
      source: calendar.source,
      syncStatus: 'pending'
    })
    assert.equal(preserved.antiTrackingEnabled, false)

    const remoteCalendar = await upsertLocalCalendar({
      id: `ghl_cal_antitracking_${suffix}`,
      ghlCalendarId: `ghl_cal_antitracking_${suffix}`,
      name: 'Remote antitracking calendar',
      slug: `remote-antitracking-calendar-${suffix}`,
      widgetSlug: `remote-antitracking-calendar-${suffix}`
    }, {
      source: 'ghl',
      syncStatus: 'synced'
    })
    calendarIds.push(remoteCalendar.id)

    assert.equal(remoteCalendar.antiTrackingEnabled, true)
  } finally {
    for (const calendarId of calendarIds) {
      await deleteLocalCalendar(calendarId).catch(() => undefined)
    }
  }
})
