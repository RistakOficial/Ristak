import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeContactLifecycleStage,
  resolveContactLifecycleStage
} from '../src/utils/contactLifecycleStage.js'

test('normaliza nombres legibles y valores canónicos de etapa comercial', () => {
  assert.equal(normalizeContactLifecycleStage('Prospecto'), 'lead')
  assert.equal(normalizeContactLifecycleStage('Agendó cita'), 'appointment')
  assert.equal(normalizeContactLifecycleStage('Asistió a cita'), 'attended')
  assert.equal(normalizeContactLifecycleStage('Cliente'), 'customer')
  assert.equal(normalizeContactLifecycleStage('etapa inventada'), '')
})

test('calcula la etapa comercial con prioridad de hechos reales', () => {
  assert.equal(resolveContactLifecycleStage({}), 'lead')
  assert.equal(resolveContactLifecycleStage({ stage: 'cliente' }), 'customer')
  assert.equal(resolveContactLifecycleStage({ activeAppointmentsCount: 1 }), 'appointment')
  assert.equal(resolveContactLifecycleStage({ activeAppointmentsCount: 1, attendedAppointmentsCount: 1 }), 'attended')
  assert.equal(resolveContactLifecycleStage({ activeAppointmentsCount: 1, attendedAppointmentsCount: 1, purchasesCount: 1 }), 'customer')
})
