import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContactListWhere,
  getContactListSortExpression,
  normalizeContactAdvancedFilters,
  normalizeContactListTrackingFilters
} from '../src/services/contactListFilterService.js'

test('normalizeContactAdvancedFilters conserva solo grupos y reglas validas', () => {
  const normalized = normalizeContactAdvancedFilters({
    groups: [
      {
        id: 'group-1',
        mode: 'any',
        negate: true,
        rules: [
          { id: 'rule-1', field: 'tags', operator: 'any', value: ['tag_a'] },
          { id: 'rule-empty', field: '', operator: 'contains', value: 'x' }
        ]
      },
      { id: 'group-empty', rules: [] }
    ],
    sort: { by: 'priority', order: 'ASC' }
  })

  assert.equal(normalized.groups.length, 1)
  assert.equal(normalized.groups[0].mode, 'any')
  assert.equal(normalized.groups[0].negate, true)
  assert.equal(normalized.groups[0].rules.length, 1)
  assert.deepEqual(normalized.sort, { by: 'priority', order: 'ASC' })
})

test('normalizeContactListTrackingFilters limpia campos y valores vacios', () => {
  assert.deepEqual(normalizeContactListTrackingFilters({
    utm_source: ['Facebook', '', 'Facebook'],
    browser: [],
    os: ['iOS']
  }), {
    utm_source: ['Facebook'],
    os: ['iOS']
  })
})

test('buildContactListWhere combina filtros rapidos, tracking y condiciones avanzadas', () => {
  const where = buildContactListWhere({
    alias: 'c',
    search: 'ana',
    quickFilter: 'appointments',
    trackingFilters: { utm_source: ['Facebook'], device_type: ['mobile'] },
    range: {
      startUtc: '2026-07-01T06:00:00.000Z',
      endUtc: '2026-07-05T05:59:59.999Z',
      appliedTimezone: 'America/Ciudad_Juarez'
    },
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [
          { field: 'tags', operator: 'any', value: ['tag_vip'] },
          { field: 'custom_field', customKey: 'city', operator: 'contains', value: 'juarez' },
          { field: 'has_future_appointment', operator: 'no' },
          { field: 'total_paid', operator: 'gt', value: '100' }
        ]
      }]
    }
  })

  assert.match(where.whereClause, /c\.deleted_at IS NULL/)
  assert.match(where.whereClause, /FROM payments p_stage_success/)
  assert.match(where.whereClause, /FROM sessions s_filter/)
  assert.match(where.whereClause, /FROM json_each|jsonb_array_elements/)
  assert.match(where.whereClause, /SUM\(p_num\.amount\)/)
  assert.ok(where.params.includes('2026-07-01T06:00:00.000Z'))
  assert.ok(where.params.includes('2026-07-05T05:59:59.999Z'))
  assert.ok(where.params.includes('%tag_vip%'))
  assert.ok(where.params.includes('city'))
  assert.ok(where.params.includes('%juarez%'))
  assert.ok(where.params.includes(100))
})

test('buildContactListWhere interpreta fechas calendario con timezone de negocio', () => {
  const where = buildContactListWhere({
    alias: 'c',
    range: { appliedTimezone: 'America/Ciudad_Juarez' },
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [{ field: 'appointment_date', operator: 'after', value: '2026-07-04' }]
      }]
    }
  })

  assert.equal(where.params.at(-1), '2026-07-05T05:59:59.999Z')
})

test('getContactListSortExpression solo expone ordenamientos permitidos', () => {
  assert.match(getContactListSortExpression('priority', 'c', 'ps'), /COALESCE\(ps\.purchases_count, 0\)/)
  assert.match(getContactListSortExpression('unknown_sort', 'c', 'ps'), /c\.created_at/)
})
