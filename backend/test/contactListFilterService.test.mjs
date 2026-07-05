import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContactListPaymentStatsCte,
  buildContactListWhere,
  contactListPrioritySortExpression,
  getContactListSortExpression,
  normalizeContactAdvancedFilters,
  normalizeContactListTrackingFilters
} from '../src/services/contactListFilterService.js'

test('normalizeContactAdvancedFilters conserva solo grupos y reglas validas', () => {
  const normalized = normalizeContactAdvancedFilters({
    groupMode: 'any',
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
  assert.equal(normalized.groupMode, 'any')
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
  assert.match(where.whereClause, /FROM payments p_stage_customer/)
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

test('buildContactListWhere permite grupos con OR y campos nativos extendidos', () => {
  const where = buildContactListWhere({
    alias: 'c',
    advancedFilters: {
      groupMode: 'any',
      groups: [
        {
          mode: 'all',
          rules: [{ field: 'assigned_user_id', operator: 'is', value: 'owner_1' }]
        },
        {
          mode: 'all',
          rules: [{ field: 'ghl_contact_id', operator: 'contains', value: 'lead_123' }]
        }
      ]
    }
  })

  assert.match(where.whereClause, /c\.assigned_user_id/)
  assert.match(where.whereClause, /c\.ghl_contact_id/)
  assert.match(where.whereClause, /\)\sOR\s\(/)
  assert.ok(where.params.includes('owner_1'))
  assert.ok(where.params.includes('%lead_123%'))
})

test('buildContactListWhere respeta tipos de campos personalizados avanzados', () => {
  const where = buildContactListWhere({
    alias: 'c',
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [
          { field: 'custom_field', customKey: 'budget', valueType: 'number', operator: 'gt', value: '2500' },
          { field: 'custom_field', customKey: 'birthday', valueType: 'date', operator: 'between', value: '2026-07-01', valueTo: '2026-07-31' },
          { field: 'custom_field', customKey: 'vip', valueType: 'boolean', operator: 'yes' }
        ]
      }]
    }
  })

  assert.match(where.whereClause, /CAST\(NULLIF\(TRIM\(CAST\(/)
  assert.match(where.whereClause, /substr\(TRIM\(CAST\(/)
  assert.match(where.whereClause, /LOWER\(TRIM\(CAST\(/)
  assert.ok(where.params.includes('budget'))
  assert.ok(where.params.includes(2500))
  assert.ok(where.params.includes('birthday'))
  assert.ok(where.params.includes('2026-07-01'))
  assert.ok(where.params.includes('2026-07-31'))
  assert.ok(where.params.includes('vip'))
})

test('buildContactListWhere parametriza la fecha actual en citas futuras', () => {
  const where = buildContactListWhere({
    alias: 'c',
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [{ field: 'has_future_appointment', operator: 'yes' }]
      }]
    }
  })

  assert.match(where.whereClause, /COALESCE\(a_bool\.start_time, a_bool\.date_added\) >= \?/)
  assert.doesNotMatch(where.whereClause, /new Date|toISOString|T\d{2}:\d{2}:\d{2}.*Z/)
  assert.match(String(where.params.at(-1)), /^\d{4}-\d{2}-\d{2}T/)
})

test('buildContactListWhere conecta filtros avanzados con catalogos reales', () => {
  const where = buildContactListWhere({
    alias: 'c',
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [
          { field: 'automation_id', operator: 'is', value: 'auto_1' },
          { field: 'payment_flow_state', operator: 'is', value: 'installment_plan_active' },
          { field: 'installment_due_date', operator: 'before', value: '2026-07-10' },
          { field: 'appointment_calendar', operator: 'is', value: 'cal_1' },
          { field: 'campaign_id', operator: 'is', value: 'cmp_1' }
        ]
      }]
    }
  })

  assert.match(where.whereClause, /FROM automation_enrollments ae_adv/)
  assert.match(where.whereClause, /LEFT JOIN automations aut_adv/)
  assert.match(where.whereClause, /FROM payment_flows pf_adv/)
  assert.match(where.whereClause, /JOIN installment_payments ip_adv/)
  assert.match(where.whereClause, /LEFT JOIN calendars cal_adv/)
  assert.match(where.whereClause, /FROM sessions s_adv/)
  assert.match(where.whereClause, /FROM meta_ads ma_adv/)
  assert.ok(where.params.includes('auto_1'))
  assert.ok(where.params.includes('installment_plan_active'))
  assert.ok(where.params.includes('cal_1'))
  assert.ok(where.params.includes('cmp_1'))
})

test('buildContactListWhere soporta condiciones booleanas nuevas de pagos y citas', () => {
  const where = buildContactListWhere({
    alias: 'c',
    advancedFilters: {
      groups: [{
        mode: 'all',
        rules: [
          { field: 'has_saved_payment_method', operator: 'yes' },
          { field: 'has_overdue_installment', operator: 'yes' },
          { field: 'has_no_show_appointment', operator: 'no' },
          { field: 'cancelled_appointments_count', operator: 'gt', value: '0' }
        ]
      }]
    }
  })

  assert.match(where.whereClause, /FROM stripe_payment_methods spm_bool/)
  assert.match(where.whereClause, /FROM conekta_payment_sources cps_bool/)
  assert.match(where.whereClause, /FROM rebill_payment_sources rps_bool/)
  assert.match(where.whereClause, /JOIN installment_payments ip_bool/)
  assert.match(where.whereClause, /no_show|noshow/)
  assert.match(where.whereClause, /COUNT\(\*\)/)
  assert.ok(where.params.includes(0))
})

test('el filtro Clientes incluye pagos exitosos test sin meterlos al total pagado', () => {
  const where = buildContactListWhere({
    alias: 'c',
    quickFilter: 'customers'
  })
  const quickFilterPaymentClause = where.whereClause.match(/FROM payments p_stage_customer[\s\S]*?\)\)/)?.[0] || ''

  assert.match(quickFilterPaymentClause, /p_stage_customer\.amount > 0/)
  assert.match(quickFilterPaymentClause, /LOWER\(COALESCE\(p_stage_customer\.status, ''\)\)/)
  assert.doesNotMatch(quickFilterPaymentClause, /payment_mode/)

  const cte = buildContactListPaymentStatsCte()
  assert.match(cte, /AS customer_payments_count/)
  assert.match(cte, /AS last_customer_payment_date/)
  assert.match(cte, /AS total_paid/)
  assert.match(cte, /COALESCE\(payments\.payment_mode, 'live'\) != 'test'/)
  assert.match(contactListPrioritySortExpression('c', 'ps'), /ps\.customer_payments_count/)
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
  assert.match(getContactListSortExpression('priority', 'c', 'ps'), /COALESCE\(ps\.customer_payments_count, ps\.purchases_count, 0\)/)
  assert.match(getContactListSortExpression('next_appointment_date', 'c', 'ps'), /MIN\(COALESCE\(a_date\.start_time/)
  assert.match(getContactListSortExpression('unknown_sort', 'c', 'ps'), /c\.created_at/)
})
