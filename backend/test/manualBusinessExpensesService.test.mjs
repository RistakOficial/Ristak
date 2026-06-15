import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  calculateManualBusinessExpensesForRange,
  getManualBusinessExpenseDescendantScope
} from '../src/services/manualBusinessExpensesService.js'

describe('manual business expense calculations', () => {
  it('uses daily overrides instead of adding them on top of monthly costs', () => {
    const expenses = [
      { period_type: 'month', period_start: '2026-06-01', amount: 30000 },
      { period_type: 'day', period_start: '2026-06-10', amount: 2000 },
      { period_type: 'day', period_start: '2026-06-11', amount: 500 }
    ]

    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-01', to: '2026-06-30' }, expenses),
      30500
    )
    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-10', to: '2026-06-10' }, expenses),
      2000
    )
  })

  it('keeps monthly distribution stable when a single day is manually changed', () => {
    const expenses = [
      { period_type: 'month', period_start: '2026-06-01', amount: 100 },
      { period_type: 'day', period_start: '2026-06-12', amount: 103.33 }
    ]

    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-01', to: '2026-06-30' }, expenses),
      200
    )
    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-11', to: '2026-06-11' }, expenses),
      3.33
    )
    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-12', to: '2026-06-12' }, expenses),
      103.33
    )
  })

  it('uses monthly overrides instead of adding them on top of yearly costs', () => {
    const expenses = [
      { period_type: 'year', period_start: '2026-01-01', amount: 120000 },
      { period_type: 'month', period_start: '2026-06-01', amount: 30000 }
    ]

    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-01-01', to: '2026-12-31' }, expenses),
      140136.99
    )
    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-01', to: '2026-06-30' }, expenses),
      30000
    )
  })

  it('keeps explicit zero values as overrides', () => {
    const expenses = [
      { period_type: 'month', period_start: '2026-06-01', amount: 30000 },
      { period_type: 'day', period_start: '2026-06-10', amount: 0 }
    ]

    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-01', to: '2026-06-30' }, expenses),
      29000
    )
    assert.equal(
      calculateManualBusinessExpensesForRange({ from: '2026-06-10', to: '2026-06-10' }, expenses),
      0
    )
  })

  it('identifies daily records reset by a monthly edit', () => {
    assert.deepEqual(
      getManualBusinessExpenseDescendantScope('month', '2026-06-01'),
      {
        from: '2026-06-01',
        to: '2026-06-30',
        periodTypes: ['day']
      }
    )
  })

  it('identifies monthly and daily records reset by a yearly edit', () => {
    assert.deepEqual(
      getManualBusinessExpenseDescendantScope('year', '2026-01-01'),
      {
        from: '2026-01-01',
        to: '2026-12-31',
        periodTypes: ['day', 'month']
      }
    )
  })
})
