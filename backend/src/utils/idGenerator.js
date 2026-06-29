import crypto from 'crypto'

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const DEFAULT_SHORT_ID_LENGTH = 20
const MAX_SHORT_ID_LENGTH = 64

function normalizeLength(length, fallback = DEFAULT_SHORT_ID_LENGTH) {
  const parsed = Number.parseInt(length, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.max(parsed, 6), MAX_SHORT_ID_LENGTH)
}

function normalizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function generateShortId(length = DEFAULT_SHORT_ID_LENGTH) {
  const size = normalizeLength(length)
  let id = ''
  for (let index = 0; index < size; index += 1) {
    id += ALPHANUMERIC[crypto.randomInt(0, ALPHANUMERIC.length)]
  }
  return id
}

export function createEntityId(prefix, { length = DEFAULT_SHORT_ID_LENGTH } = {}) {
  const cleanPrefix = normalizeIdPart(prefix)
  return cleanPrefix ? `${cleanPrefix}_${generateShortId(length)}` : generateShortId(length)
}

export function createRistakId(entity, options = {}) {
  const cleanEntity = normalizeIdPart(entity)
  return createEntityId(cleanEntity ? `rstk_${cleanEntity}` : 'rstk', options)
}

export function createPublicPaymentId() {
  return createRistakId('pay')
}

export function createRistakPaymentEntityId(source = 'payment') {
  const normalized = normalizeIdPart(source).toLowerCase()

  if (normalized.includes('flow')) return createRistakId('payment_flow')
  if (normalized.includes('installment') || normalized === 'inst') return createRistakId('installment')
  if (normalized.includes('source')) return createRistakId('payment_source')
  if (normalized.includes('method') || normalized.endsWith('_pm') || normalized === 'pm') return createRistakId('payment_method')

  return createRistakId('payment')
}
