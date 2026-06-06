import { formatName } from './format'

const PHONE_DIGIT_LENGTH = 10

const STATUS_PRIORITY: Record<string, number> = {
  customer: 3,
  appointment: 2,
  lead: 1
}

const SUCCESS_STATUSES = new Set([
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
])

const REFUND_STATUSES = new Set(['refunded', 'refund'])

interface DedupedMetadata {
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
}

type ContactLike = {
  id?: string | number | null
  phone?: string | null
  name?: string | null
  full_name?: string | null
  fullName?: string | null
  contactName?: string | null
  status?: string | null
  createdAt?: string | null
  created_at?: string | null
  lastPurchase?: string | null
  last_purchase?: string | null
  purchases?: number | null
  ltv?: number | null
  payments?: Array<{ id?: string | number; status?: string | null }> | null
  appointments?: Array<{ id?: string | number; status?: string | null }> | null
  is_sale?: boolean | null
  [key: string]: any
}

type WithMetadata<T> = T & DedupedMetadata

function applyNameFormatting<U extends ContactLike>(contact: U): U {
  if (!contact) {
    return contact
  }

  const target = contact as Record<string, unknown>

  if (typeof target.name === 'string') {
    target.name = formatName(target.name)
  }
  if (typeof target.full_name === 'string') {
    target.full_name = formatName(target.full_name)
  }
  if (typeof target.fullName === 'string') {
    target.fullName = formatName(target.fullName)
  }
  if (typeof target.contactName === 'string') {
    target.contactName = formatName(target.contactName)
  }

  return contact
}

function extractPhone(contact?: ContactLike | null): string | null {
  if (!contact) {
    return null
  }

  const nestedContact = (contact as any)?.contact
  const candidates = [
    contact.phone,
    contact.contactPhone,
    contact.contact_phone,
    contact.phoneNumber,
    contact.phone_number,
    contact.primaryPhone,
    contact.primary_phone,
    nestedContact?.phone,
    nestedContact?.phoneNumber,
    nestedContact?.phone_number
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }

  return null
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) {
    return null
  }
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < PHONE_DIGIT_LENGTH) {
    return null
  }
  return digits.slice(-PHONE_DIGIT_LENGTH)
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toTimestamp(value?: string | null): number {
  if (!value) {
    return 0
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function getId(contact: ContactLike): string | null {
  const id = contact.id ?? contact.contact_id ?? contact.contactId ?? null
  return id != null ? String(id) : null
}

function getName(contact: ContactLike): string {
  const name = contact.name ?? contact.full_name ?? contact.fullName ?? ''
  return typeof name === 'string' ? name : ''
}

function getStatusPriority(contact: ContactLike): number {
  const status = String(contact.status ?? '').toLowerCase()
  return STATUS_PRIORITY[status] ?? 0
}

function getCreatedAt(contact: ContactLike): string | null {
  return contact.createdAt ?? contact.created_at ?? null
}

function getLastPurchase(contact: ContactLike): string | null {
  return contact.lastPurchase ?? contact.last_purchase ?? null
}

function getPaymentsArray(contact: ContactLike): Array<{ id?: string | number; status?: string | null }> {
  if (Array.isArray(contact.payments)) {
    return contact.payments
  }
  if (Array.isArray(contact.payment_details)) {
    return contact.payment_details
  }
  return []
}

function getAppointmentsArray(contact: ContactLike): Array<{ id?: string | number; status?: string | null }> {
  if (Array.isArray(contact.appointments)) {
    return contact.appointments
  }
  if (Array.isArray(contact.appointment_details)) {
    return contact.appointment_details
  }
  return []
}

function countSuccessfulPayments(contact: ContactLike): number {
  const payments = getPaymentsArray(contact)
  let count = 0
  for (const payment of payments) {
    const status = String(payment?.status ?? '').toLowerCase()
    if (status && SUCCESS_STATUSES.has(status) && !REFUND_STATUSES.has(status)) {
      count++
    }
  }
  return count
}

function getAppointmentsCount(contact: ContactLike): number {
  const appointments = getAppointmentsArray(contact)
  if (appointments.length) {
    return appointments.length
  }
  const count = contact.appointments_count ?? contact.appointment_count
  return toNumber(count)
}

function getPurchasesCount(contact: ContactLike): number {
  const purchases = toNumber(contact.purchases)
  if (purchases > 0) {
    return purchases
  }
  if (contact.is_sale) {
    return 1
  }
  const successfulPayments = countSuccessfulPayments(contact)
  if (successfulPayments > 0) {
    return successfulPayments
  }
  return 0
}

function hasSale(contact: ContactLike): boolean {
  const purchases = getPurchasesCount(contact)
  if (purchases > 0) {
    return true
  }
  if (toNumber(contact.ltv) > 0) {
    return true
  }
  if (getStatusPriority(contact) >= STATUS_PRIORITY.customer) {
    return true
  }
  return false
}

function compareDesc(a: number, b: number): number {
  if (a === b) return 0
  return a > b ? -1 : 1
}

function compareAsc(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareContacts(a: ContactLike, b: ContactLike): number {
  const hasSaleDiff = compareDesc(Number(hasSale(a)), Number(hasSale(b)))
  if (hasSaleDiff !== 0) return hasSaleDiff

  const saleCountDiff = compareDesc(getPurchasesCount(a), getPurchasesCount(b))
  if (saleCountDiff !== 0) return saleCountDiff

  const ltvDiff = compareDesc(toNumber(a.ltv), toNumber(b.ltv))
  if (ltvDiff !== 0) return ltvDiff

  const appointmentDiff = compareDesc(getAppointmentsCount(a), getAppointmentsCount(b))
  if (appointmentDiff !== 0) return appointmentDiff

  const statusDiff = compareDesc(getStatusPriority(a), getStatusPriority(b))
  if (statusDiff !== 0) return statusDiff

  const lastPurchaseDiff = compareDesc(toTimestamp(getLastPurchase(a)), toTimestamp(getLastPurchase(b)))
  if (lastPurchaseDiff !== 0) return lastPurchaseDiff

  const createdDiff = compareDesc(toTimestamp(getCreatedAt(a)), toTimestamp(getCreatedAt(b)))
  if (createdDiff !== 0) return createdDiff

  const nameDiff = compareAsc(getName(a).toLowerCase(), getName(b).toLowerCase())
  if (nameDiff !== 0) return nameDiff

  const idA = getId(a) ?? ''
  const idB = getId(b) ?? ''
  return compareAsc(idA, idB)
}

function mergeUniqueItems<T extends { id?: string | number | null }>(items: T[]): T[] {
  const result: T[] = []
  const seen = new Set<string>()

  for (const item of items) {
    if (!item) continue
    const identifier = item.id != null ? String(item.id) : null
    if (identifier) {
      if (seen.has(identifier)) continue
      seen.add(identifier)
    }
    result.push({ ...item })
  }

  return result
}

function calculatePaymentStats(payments: Array<{ status?: string | null; amount?: number | string | null }>) {
  let successCount = 0
  let successAmount = 0

  for (const payment of payments) {
    const status = String(payment?.status ?? '').toLowerCase()
    const amount = toNumber(payment?.amount)

    if (SUCCESS_STATUSES.has(status)) {
      successCount += 1
      successAmount += amount
    } else if (REFUND_STATUSES.has(status)) {
      successAmount -= amount
    }
  }

  return { successCount, successAmount }
}

function aggregateGroup<T extends ContactLike>(group: T[], normalizedPhone: string | null): WithMetadata<T> {
  const sorted = [...group].sort(compareContacts)
  const primary = sorted[0]
  const merged: WithMetadata<T> = {
    ...(primary ? { ...primary } : ({} as T)),
    normalizedPhone,
    duplicateCount: group.length,
    mergedContactIds: group
      .map(item => getId(item))
      .filter((id): id is string => Boolean(id))
  }

  if (!primary) {
    return merged
  }

  const paymentsCollections = group.flatMap(item => getPaymentsArray(item))
  const mergedPayments = paymentsCollections.length > 0 || Array.isArray(primary.payments)
    ? mergeUniqueItems(paymentsCollections)
    : undefined
  if (mergedPayments) {
    (merged as any).payments = mergedPayments
  }

  const paymentStats = mergedPayments ? calculatePaymentStats(mergedPayments) : { successCount: 0, successAmount: 0 }

  const purchasesValues = group.map(item => toNumber(item.purchases))
  const bestPurchases = Math.max(0, ...purchasesValues)
  const finalPurchases = Math.max(bestPurchases, paymentStats.successCount)
  if ('purchases' in primary) {
    (merged as any).purchases = finalPurchases
  }

  const ltvValues = group.map(item => toNumber(item.ltv))
  const bestLtv = Math.max(0, ...ltvValues)
  const finalLtv = Math.max(bestLtv, paymentStats.successAmount)
  if ('ltv' in primary) {
    (merged as any).ltv = finalLtv
  }

  const appointmentsCollections = group.flatMap(item => getAppointmentsArray(item))
  if (appointmentsCollections.length > 0 || Array.isArray(primary.appointments)) {
    (merged as any).appointments = mergeUniqueItems(appointmentsCollections)
  }

  // Update status with the highest priority
  if ('status' in primary) {
    const bestStatusContact = sorted.slice().sort((a, b) => compareDesc(getStatusPriority(a), getStatusPriority(b)))[0]
    if (bestStatusContact?.status) {
      (merged as any).status = bestStatusContact.status
    }
  }

  // Last purchase should reflect the most recent event
  const latestPurchaseContact = sorted.slice().sort((a, b) => compareDesc(toTimestamp(getLastPurchase(a)), toTimestamp(getLastPurchase(b))))[0]
  const latestPurchase = getLastPurchase(latestPurchaseContact)
  if (latestPurchase) {
    (merged as any).lastPurchase = latestPurchase
    if ('last_purchase' in primary) {
      (merged as any).last_purchase = latestPurchase
    }
  }

  // If any contact in the group has a positive sale flag, propagate it
  if ('is_sale' in primary) {
    (merged as any).is_sale = group.some(item => Boolean(item.is_sale) || getPurchasesCount(item) > 0)
  }

  if (!(merged as any).email) {
    const withEmail = sorted.find(item => item?.email)
    if (withEmail?.email) {
      (merged as any).email = withEmail.email
    }
  }

  if (!(merged as any).name && !(merged as any).full_name) {
    const withName = sorted.find(item => item?.name || item?.full_name)
    if (withName) {
      if (withName.name) (merged as any).name = withName.name
      if (withName.full_name) (merged as any).full_name = withName.full_name
    }
  }

  return applyNameFormatting(merged as WithMetadata<T>)
}

export function dedupeContacts<T extends ContactLike>(contacts: T[]): Array<WithMetadata<T>> {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return []
  }

  const groups = new Map<string, { items: T[]; firstIndex: number }>()
  const uniques: Array<{ index: number; item: WithMetadata<T> }> = []

  contacts.forEach((contact, index) => {
    // Prioridad 1: Email (normalizado)
    const email = contact?.email?.toLowerCase().trim()
    const hasValidEmail = email && email.includes('@')

    // Prioridad 2: Teléfono (normalizado)
    const normalizedPhone = normalizePhone(extractPhone(contact))

    // Crear key única: prioriza email > teléfono
    const dedupKey = hasValidEmail
      ? `email::${email}`
      : normalizedPhone
        ? `phone::${normalizedPhone}`
        : null

    if (!dedupKey) {
      // Sin email ni teléfono → no deduplicar
      const cloned: WithMetadata<T> = {
        ...(contact ? { ...contact } : ({} as T)),
        normalizedPhone: null,
        duplicateCount: 1,
        mergedContactIds: [getId(contact)].filter((id): id is string => Boolean(id))
      }
      applyNameFormatting(cloned as ContactLike)
      uniques.push({ index, item: cloned })
      return
    }

    const group = groups.get(dedupKey)
    if (group) {
      group.items.push(contact)
    } else {
      groups.set(dedupKey, { items: [contact], firstIndex: index })
    }
  })

  groups.forEach(({ items, firstIndex }) => {
    // Extraer normalizedPhone del primero para mantener compatibilidad
    const normalizedPhone = normalizePhone(extractPhone(items[0]))
    const aggregated = aggregateGroup(items, normalizedPhone)
    uniques.push({ index: firstIndex, item: aggregated })
  })

  uniques.sort((a, b) => a.index - b.index)
  return uniques.map(entry => entry.item)
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object') {
    return false
  }
  if (Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isContactCandidate(value: unknown): value is ContactLike {
  if (!isPlainObject(value)) {
    return false
  }

  // IMPORTANTE: Excluir transactions/payments de la deduplicación
  // Los payments tienen campos: id, date, contactId, contactName, amount, method, status
  // Si tiene 'amount' y 'status', probablemente es un payment, NO un contacto
  const obj = value as Record<string, any>
  if ('amount' in obj && 'status' in obj && 'date' in obj) {
    return false // Es un payment/transaction, no deduplicar
  }

  return Boolean(extractPhone(value as ContactLike))
}

function dedupeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.some(item => isContactCandidate(item))) {
      return dedupeContacts(value as ContactLike[])
    }

    let changed = false
    const nextArray = value.map(item => {
      const nextItem = dedupeValue(item)
      if (nextItem !== item) {
        changed = true
      }
      return nextItem
    })
    return changed ? nextArray : value
  }

  if (isPlainObject(value)) {
    let changed = false
    const result: Record<string, unknown> = {}
    for (const [key, current] of Object.entries(value)) {
      const next = dedupeValue(current)
      result[key] = next
      if (next !== current) {
        changed = true
      }
    }
    return changed ? result : value
  }

  return value
}

export function dedupeContactsPayload<T>(payload: T): T {
  return dedupeValue(payload) as T
}
