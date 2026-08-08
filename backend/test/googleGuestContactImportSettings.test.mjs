import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createLocalCalendar,
  deleteLocalCalendar,
  getLocalCalendar,
  updateLocalCalendar
} from '../src/services/localCalendarService.js'

const makeSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('new calendars disable Google guest contact import and preserve explicit changes', async () => {
  const suffix = makeSuffix()
  let calendar

  try {
    calendar = await createLocalCalendar({
      id: `rstk_cal_google_guest_setting_${suffix}`,
      name: 'Google guest setting'
    })

    assert.equal(calendar.googleGuestContactImportEnabled, false)

    const enabled = await updateLocalCalendar(calendar.id, {
      googleGuestContactImportEnabled: true
    })
    assert.equal(enabled.googleGuestContactImportEnabled, true)

    const preserved = await updateLocalCalendar(calendar.id, {
      name: 'Google guest setting renamed'
    })
    assert.equal(preserved.googleGuestContactImportEnabled, true)
  } finally {
    if (calendar) await deleteLocalCalendar(calendar.id).catch(() => undefined)
  }
})

test('legacy calendars without the setting keep importing Google guests', async () => {
  const suffix = makeSuffix()
  let calendar

  try {
    calendar = await createLocalCalendar({
      id: `rstk_cal_google_guest_legacy_${suffix}`,
      name: 'Legacy Google guest setting'
    })
    await db.run('UPDATE calendars SET raw_json = ? WHERE id = ?', ['{}', calendar.id])

    const reloaded = await getLocalCalendar(calendar.id)
    assert.equal(reloaded.googleGuestContactImportEnabled, true)
  } finally {
    if (calendar) await deleteLocalCalendar(calendar.id).catch(() => undefined)
  }
})
