import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DateTime } from 'luxon'

// Isolate policy functions from database/notifications. These are the production
// function bodies, not a second implementation of the booking policy.
const local = readFileSync(new URL('../src/services/localCalendarService.js', import.meta.url), 'utf8')
const sites = readFileSync(new URL('../src/services/sitesService.js', import.meta.url), 'utf8')
const functionBody = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const cleanString = value => typeof value === 'string' ? value.trim() : ''
const getWindow = new Function('DateTime', 'cleanString', 'addCalendarRuleDuration', 'getCalendarAvailableWeekdays', `
${functionBody(local, 'function getCalendarAvailableDayHorizon(', 'function getCalendarBookingWindow(')}
${functionBody(local, 'function getCalendarBookingWindow(', 'function toBoolInt(')}
return getCalendarBookingWindow`)(DateTime, cleanString, (now, n, unit) => now.plus({ [unit]: Number(n || 0) }), () => new Set([1,2,3,4,5]))

for (const [day, last] of [
  ['2026-11-19', '2026-11-24'], // Thu -> Fri Mon Tue
  ['2026-11-20', '2026-11-25'], // Fri -> Mon Tue Wed
  ['2026-11-21', '2026-11-25'],
  ['2026-11-22', '2026-11-25']
]) test(`future weekdays from ${day}, today excluded`, () => {
  const zone = 'America/Ciudad_Juarez'
  const now = DateTime.fromISO(`${day}T13:15:00`, { zone })
  const calendar = { allowBookingAfter: 1, allowBookingAfterUnit: 'days', allowBookingFor: 3, allowBookingForUnit: 'days' }
  const result = getWindow(calendar, zone, now.toMillis(), { futureBusinessDays: 3 })
  assert.equal(DateTime.fromMillis(result.latestStartMs, { zone }).toISODate(), last)
  assert.equal(result.latestStartMs, DateTime.fromISO(last, { zone }).endOf('day').toMillis())
  assert.equal(result.earliestStartMs, now.plus({ days: 1 }).toMillis(), 'retain full minimum notice')
  assert.equal(result.weekdaysOnly, true)
  assert.equal(getWindow(calendar, zone, now.toMillis()).weekdaysOnly, false)
})

test('local midnight, invalid override and unchanged direct horizon', () => {
  const zone = 'America/Ciudad_Juarez'
  const calendar = { allowBookingAfter: 0, allowBookingFor: 3, allowBookingForUnit: 'days' }
  const now = DateTime.fromISO('2026-11-20T06:59:59Z').setZone(zone) // still Thursday
  const result = getWindow(calendar, zone, now.toMillis(), { futureBusinessDays: 3 })
  assert.equal(DateTime.fromMillis(result.latestStartMs, { zone }).toISODate(), '2026-11-24')
  assert.equal(DateTime.fromMillis(result.earliestStartMs, { zone }).toISODate(), '2026-11-20')
  const original = getWindow(calendar, zone, now.toMillis())
  assert.equal(DateTime.fromMillis(original.latestStartMs, { zone }).toISODate(), '2026-11-23')
  assert.deepEqual(getWindow(calendar, zone, now.toMillis(), { futureBusinessDays: '3' }), original)
})

const policyBody = functionBody(sites, 'export async function resolveSiteCalendarWindow(', 'function getImportedCustomCalendarConfig(').replace('export ', '')
const valid = () => ({ ok: true, pageId: 'page-2', site: { blocks: [{ id: 'block', blockType: 'calendar_embed', settings: { pageId: 'page-2', calendarId: 'cal', calendarFutureBusinessDays: 3 } }] } })
function resolveWith(source) {
  return new Function('cleanString', 'resolvePublicSiteForHost', 'getImportedRenderPage', 'normalizePublicRouteSegments', 'buildPublicPageRoutePath', `${policyBody};return resolveSiteCalendarWindow`)(cleanString, async () => source, (_site, pageId) => ({ id: pageId }), p => p.split('/').filter(Boolean), () => '/asesoria-medicos-calendario')
}
const context = { siteCalendarBlock: 'block', siteCalendarPath: '/asesoria-medicos-calendario' }
test('persisted matching site/page/block/calendar only; no visitor day override', async () => {
  assert.deepEqual(await resolveWith(valid())('example.com', { id: 'cal' }, context), { futureBusinessDays: 3 })
  assert.deepEqual(await resolveWith(valid())('example.com', { id: 'cal' }, { futureBusinessDays: 999 }), {})
  for (const input of [{ ...context, siteCalendarPath: '/other' }, { ...context, siteCalendarBlock: 'other' }, { ...context, siteCalendarPath: '//evil' }]) {
    await assert.rejects(resolveWith(valid())('example.com', { id: 'cal' }, input), { status: 400 })
  }
  await assert.rejects(resolveWith(valid())('example.com', { id: 'other-cal' }, context), { status: 400 })
  for (const mutation of [s => s.ok = false, s => s.pageId = 'other-page', s => delete s.site.blocks[0].settings.calendarFutureBusinessDays]) {
    const source = valid(); mutation(source)
    await assert.rejects(resolveWith(source)('example.com', { id: 'cal' }, context), { status: 400 })
  }
})

test('both read and transaction enforce resolved policy; preview stays no-write', () => {
  const controller = readFileSync(new URL('../src/controllers/calendarsController.js', import.meta.url), 'utf8')
  assert.equal((controller.match(/resolveSiteCalendarWindow\(host, calendar, req.query\)/g) || []).length, 2)
  assert.match(controller, /enforceCalendarRules: true,\s+timezone: businessTimezone,\s+\.\.\.windowOptions/)
  assert.equal((local.match(/bookingWindow.weekdaysOnly && DateTime.fromMillis/g) || []).length, 2)
  assert.match(sites, /siteCalendarBlock: !context.preview/)
})
