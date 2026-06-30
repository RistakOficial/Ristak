import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  getTimezoneOffsetMinutes,
  sqliteTimezoneOffsetClause
} from '../src/utils/dateUtils.js'
import { getGroupExpression } from '../src/services/analyticsService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..')

const readRepoFile = (path) => readFileSync(join(repoRoot, path), 'utf8')

test('SQLite timezone SQL helpers derive offsets from the requested business timezone', () => {
  const winterReference = new Date('2026-01-15T12:00:00.000Z')
  const summerReference = new Date('2026-07-15T12:00:00.000Z')

  assert.equal(getTimezoneOffsetMinutes('UTC', winterReference), 0)
  assert.equal(sqliteTimezoneOffsetClause('UTC', winterReference), "'0 minutes'")
  assert.equal(sqliteTimezoneOffsetClause('America/Tijuana', winterReference), "'-480 minutes'")
  assert.equal(sqliteTimezoneOffsetClause('America/New_York', summerReference), "'-240 minutes'")
  assert.equal(sqliteTimezoneOffsetClause('Asia/Kolkata', winterReference), "'330 minutes'")
})

test('analytics SQLite grouping no longer embeds a fixed Mexico offset', () => {
  const expression = getGroupExpression('created_at', 'day', 'UTC')

  assert.equal(expression, "strftime('%Y-%m-%d', datetime(created_at, '0 minutes'))")
  assert.doesNotMatch(expression, /-6 hours/)
})

test('CRM frontend date fallbacks use account timezone helpers instead of browser timezone', () => {
  const transactions = readRepoFile('frontend/src/pages/Transactions/Transactions.tsx')
  const appointments = readRepoFile('frontend/src/pages/Appointments/Appointments.tsx')
  const appointmentModal = readRepoFile('frontend/src/components/common/AppointmentModal/AppointmentModal.tsx')
  const blockedSlotModal = readRepoFile('frontend/src/components/common/BlockedSlotModal/BlockedSlotModal.tsx')
  const calendarsConfiguration = readRepoFile('frontend/src/pages/Settings/CalendarsConfiguration.tsx')
  const localCalendarService = readRepoFile('backend/src/services/localCalendarService.js')

  assert.match(transactions, /buildPaymentTimestamp\(transaction\.date,\s*timezone\)/)
  assert.doesNotMatch(transactions, /buildPaymentTimestamp\(transaction\.date\)/)

  for (const source of [appointments, appointmentModal, blockedSlotModal, calendarsConfiguration]) {
    assert.doesNotMatch(source, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/)
  }

  assert.doesNotMatch(appointmentModal, /const DEFAULT_TIMEZONE = 'UTC'/)
  assert.doesNotMatch(blockedSlotModal, /const DEFAULT_TIMEZONE = Intl\.DateTimeFormat/)
  assert.match(calendarsConfiguration, /detectCalendarPreviewTimezone\(accountTimezone\)/)
  assert.match(localCalendarService, /isSupportedTimezone\(calendar\.defaultTimezone\) \? calendar\.defaultTimezone : 'UTC'/)
  assert.doesNotMatch(localCalendarService, /isSupportedTimezone\(browserTimezone\) \? browserTimezone : 'UTC'/)
})

test('timezone-sensitive backend services do not hardcode UTC-6 SQLite buckets', () => {
  const files = [
    'backend/src/services/originDistributionService.js',
    'backend/src/services/videoTrackingService.js',
    'backend/src/services/aiAgentService.js',
    'backend/src/controllers/trackingController.js'
  ]

  for (const file of files) {
    const source = readRepoFile(file)
    assert.doesNotMatch(source, /-6 hours/, `${file} must use sqliteTimezoneOffsetClause`)
  }
})
