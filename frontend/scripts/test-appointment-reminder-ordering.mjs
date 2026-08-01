import assert from 'node:assert/strict'
import test from 'node:test'

import { sortAppointmentRemindersByTimeline } from '../src/services/appointmentReminderOrdering.ts'

const reminder = (id, timingAnchor, offsetValue, offsetUnit, position) => ({
  id,
  timingAnchor,
  offsetValue,
  offsetUnit,
  position,
  createdAt: `2026-07-31T00:00:0${position}.000Z`
})

test('ordena avisos y recordatorios por su momento real, no por creación', () => {
  const createdOrder = [
    reminder('ten-minutes-before', 'before_appointment', 10, 'minutes', 0),
    reminder('three-hours-before', 'before_appointment', 3, 'hours', 1),
    reminder('at-booking', 'after_booking', 0, 'minutes', 2),
    reminder('three-days-before', 'before_appointment', 3, 'days', 3),
    reminder('five-minutes-after-booking', 'after_booking', 5, 'minutes', 4),
    reminder('one-day-before', 'before_appointment', 1, 'days', 5)
  ]

  const sorted = sortAppointmentRemindersByTimeline(createdOrder)

  assert.deepEqual(sorted.map(item => item.id), [
    'at-booking',
    'five-minutes-after-booking',
    'three-days-before',
    'one-day-before',
    'three-hours-before',
    'ten-minutes-before'
  ])
  assert.deepEqual(createdOrder.map(item => item.id), [
    'ten-minutes-before',
    'three-hours-before',
    'at-booking',
    'three-days-before',
    'five-minutes-after-booking',
    'one-day-before'
  ])
})

test('conserva position y creación como desempate para el mismo momento', () => {
  const sorted = sortAppointmentRemindersByTimeline([
    reminder('second', 'before_appointment', 1, 'days', 8),
    reminder('first', 'before_appointment', 24, 'hours', 3)
  ])

  assert.deepEqual(sorted.map(item => item.id), ['first', 'second'])
})
