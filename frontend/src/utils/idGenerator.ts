const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const DEFAULT_SHORT_ID_LENGTH = 20

const normalizeLength = (length = DEFAULT_SHORT_ID_LENGTH) => {
  const parsed = Number.parseInt(String(length), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHORT_ID_LENGTH
  return Math.min(Math.max(parsed, 6), 64)
}

const normalizeIdPart = (value: string) => (
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
)

export function createShortId(length = DEFAULT_SHORT_ID_LENGTH) {
  const size = normalizeLength(length)
  const bytes = new Uint8Array(size)

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < size; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  return Array.from(bytes, byte => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join('')
}

export function createRistakId(entity: string, options: { length?: number } = {}) {
  const cleanEntity = normalizeIdPart(entity)
  const prefix = cleanEntity ? `rstk_${cleanEntity}` : 'rstk'
  return `${prefix}_${createShortId(options.length)}`
}
