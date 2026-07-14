function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function cleanId(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function combineRruleStart(rrule = {}) {
  if (!rrule || typeof rrule !== 'object' || !rrule.startDate) return null
  if (!rrule.startTime) return rrule.startDate

  const time = String(rrule.startTime)
  return `${rrule.startDate}T${time.length === 5 ? `${time}:00` : time}`
}

function resolveScheduleObject(schedule = {}) {
  return schedule.schedule && typeof schedule.schedule === 'object'
    ? schedule.schedule
    : {}
}

function resolveScheduleRecurrence(schedule = {}) {
  const scheduleConfig = resolveScheduleObject(schedule)
  return firstDefined(
    scheduleConfig.rrule,
    schedule.rrule,
    schedule.recurrence,
    schedule.recurring,
    scheduleConfig.recurrence
  ) || null
}

function resolveSchedulePrimaryDate(schedule = {}) {
  const scheduleConfig = resolveScheduleObject(schedule)
  const recurrence = resolveScheduleRecurrence(schedule)

  return firstDefined(
    schedule.nextRunAt,
    schedule.next_run_at,
    schedule.nextInvoiceDate,
    schedule.next_invoice_date,
    schedule.nextExecutionAt,
    schedule.next_execution_at,
    schedule.nextScheduleAt,
    schedule.next_schedule_at,
    schedule.nextDate,
    schedule.next_date,
    scheduleConfig.executeAt,
    scheduleConfig.execute_at,
    combineRruleStart(recurrence),
    schedule.startDate,
    schedule.start_date,
    schedule.dueDate,
    schedule.due_date,
    schedule.updatedAt,
    schedule.updated_at,
    schedule.createdAt,
    schedule.created_at
  ) || null
}

function resolveScheduleTotal(schedule = {}) {
  const direct = numberOrNull(firstDefined(
    schedule.total,
    schedule.amount,
    schedule.grandTotal,
    schedule.grand_total,
    schedule.invoiceTotal,
    schedule.invoice_total,
    schedule.balance
  ))

  if (direct !== null) return direct

  const items = toArray(firstDefined(schedule.items, schedule.invoiceItems, schedule.lineItems))
  const total = items.reduce((sum, item) => {
    const amount = numberOrNull(firstDefined(item.amount, item.price, item.unitAmount, item.unit_amount)) || 0
    const quantity = numberOrNull(firstDefined(item.qty, item.quantity)) || 1
    return sum + amount * quantity
  }, 0)

  return total > 0 ? Math.round(total * 100) / 100 : 0
}

function resolveContactDetails(schedule = {}) {
  return firstDefined(
    schedule.contactDetails,
    schedule.contact,
    schedule.customer,
    schedule.client
  ) || {}
}

function resolveContactName(contact = {}) {
  return firstDefined(
    contact.name,
    contact.fullName,
    contact.full_name,
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim(),
    contact.email,
    contact.phone,
    ''
  )
}

function resolveRecurrenceLabel(schedule = {}) {
  const recurrence = resolveScheduleRecurrence(schedule)
  const intervalType = recurrence?.intervalType || recurrence?.frequency || schedule.frequency || schedule.intervalType
  const interval = recurrence?.interval || schedule.interval || 1

  if (!intervalType) return 'Sin recurrencia'

  const labels = {
    daily: 'Diario',
    weekly: 'Semanal',
    monthly: 'Mensual',
    yearly: 'Anual',
    custom: 'Personalizado'
  }
  const baseLabel = labels[String(intervalType).toLowerCase()] || String(intervalType)
  return Number(interval) > 1 ? `${baseLabel} cada ${interval}` : baseLabel
}

export function extractHighLevelInvoiceScheduleList(response) {
  if (Array.isArray(response)) return response

  const candidates = [
    response?.schedules,
    response?.invoiceSchedules,
    response?.invoice_schedules,
    response?.data?.schedules,
    response?.data?.invoiceSchedules,
    response?.data?.invoice_schedules,
    response?.data,
    response?.items,
    response?.results
  ]

  return candidates.find(Array.isArray) || []
}

export function resolveHighLevelInvoiceScheduleId(schedule = {}, { preferred = [] } = {}) {
  const contact = resolveContactDetails(schedule)
  const contactIds = new Set([
    contact.id,
    contact._id,
    schedule.contactId,
    schedule.contact_id
  ].map(cleanId).filter(Boolean))

  const explicitCandidates = [
    ...toArray(preferred),
    schedule.scheduleId,
    schedule.schedule_id,
    schedule.invoiceScheduleId,
    schedule.invoice_schedule_id,
    schedule.ghl_schedule_id,
    schedule.invoiceSchedule?.id,
    schedule.invoiceSchedule?._id,
    schedule.invoiceSchedule?.scheduleId,
    schedule.invoiceSchedule?.schedule_id,
    schedule.invoice_schedule?.id,
    schedule.invoice_schedule?._id,
    schedule.invoice_schedule?.scheduleId,
    schedule.invoice_schedule?.schedule_id
  ]
  const genericCandidates = [schedule._id, schedule.id]

  return [...explicitCandidates, ...genericCandidates]
    .map(cleanId)
    .filter(Boolean)
    .find(candidate => !contactIds.has(candidate)) || ''
}

export function normalizeHighLevelInvoiceSchedule(schedule = {}, options = {}) {
  const id = resolveHighLevelInvoiceScheduleId(schedule, {
    preferred: options.preferredIds || []
  })
  const contact = resolveContactDetails(schedule)
  const scheduleConfig = resolveScheduleObject(schedule)
  const recurrence = resolveScheduleRecurrence(schedule)
  const primaryDate = resolveSchedulePrimaryDate(schedule)
  const items = toArray(firstDefined(schedule.items, schedule.invoiceItems, schedule.lineItems))
  const status = String(firstDefined(
    schedule.status,
    schedule.scheduleStatus,
    schedule.schedule_status,
    schedule.state,
    'active'
  )).toLowerCase()
  const providerCurrency = firstDefined(schedule.currency, scheduleConfig.currency)
  const currency = String(providerCurrency || options.fallbackCurrency || '').trim().toUpperCase() || null

  return {
    id,
    name: firstDefined(schedule.name, schedule.title, schedule.invoiceName, schedule.invoice_name, 'Plan de pago'),
    title: firstDefined(schedule.title, schedule.name, 'Plan de pago'),
    status,
    total: resolveScheduleTotal(schedule),
    currency,
    contactId: firstDefined(contact.id, contact._id, schedule.contactId, schedule.contact_id),
    contactName: resolveContactName(contact),
    email: firstDefined(contact.email, schedule.email, ''),
    phone: firstDefined(contact.phoneNo, contact.phone, schedule.phone, ''),
    description: firstDefined(
      items[0]?.description,
      items[0]?.name,
      schedule.description,
      schedule.termsNotes,
      ''
    ),
    startDate: firstDefined(
      schedule.startDate,
      schedule.start_date,
      scheduleConfig.startDate,
      recurrence?.startDate,
      combineRruleStart(recurrence)
    ),
    nextRunAt: primaryDate,
    endDate: firstDefined(
      schedule.endDate,
      schedule.end_date,
      scheduleConfig.endDate,
      recurrence?.endDate
    ),
    recurrenceLabel: resolveRecurrenceLabel(schedule),
    liveMode: schedule.liveMode,
    itemCount: items.length,
    createdAt: firstDefined(schedule.createdAt, schedule.created_at),
    updatedAt: firstDefined(schedule.updatedAt, schedule.updated_at),
    raw: schedule,
    scheduleConfig
  }
}
