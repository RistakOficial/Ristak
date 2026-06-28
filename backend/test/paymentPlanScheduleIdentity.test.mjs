import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeInvoiceSchedule,
  resolveInvoiceScheduleId
} from '../src/controllers/highlevelController.js'

test('planes GHL: no usa el id del contacto como id local del plan', () => {
  const contactId = 'ghl_contact_same_contact'
  const scheduleId = 'ghl_schedule_first_plan'
  const schedule = {
    id: contactId,
    contactDetails: {
      id: contactId,
      name: 'Cliente con dos planes',
      email: 'cliente@example.test'
    },
    title: 'Plan uno',
    total: 1200,
    currency: 'MXN',
    schedule: {
      rrule: {
        startDate: '2099-01-01',
        intervalType: 'monthly',
        interval: 1
      }
    }
  }

  assert.equal(resolveInvoiceScheduleId(schedule, { preferred: [scheduleId] }), scheduleId)

  const normalized = normalizeInvoiceSchedule(schedule, { preferredIds: [scheduleId] })

  assert.equal(normalized.id, scheduleId)
  assert.equal(normalized.contactId, contactId)
  assert.equal(normalized.title, 'Plan uno')
})

test('planes GHL: dos planes del mismo contacto conservan ids distintos', () => {
  const contactId = 'ghl_contact_two_plans'
  const firstPlan = normalizeInvoiceSchedule({
    id: contactId,
    contactDetails: { id: contactId, name: 'Cliente dos planes' },
    title: 'Plan A',
    total: 1000
  }, { preferredIds: ['ghl_schedule_plan_a'] })
  const secondPlan = normalizeInvoiceSchedule({
    id: contactId,
    contactDetails: { id: contactId, name: 'Cliente dos planes' },
    title: 'Plan B',
    total: 2000
  }, { preferredIds: ['ghl_schedule_plan_b'] })

  assert.equal(firstPlan.contactId, secondPlan.contactId)
  assert.notEqual(firstPlan.id, secondPlan.id)
  assert.deepEqual([firstPlan.id, secondPlan.id], ['ghl_schedule_plan_a', 'ghl_schedule_plan_b'])
})
