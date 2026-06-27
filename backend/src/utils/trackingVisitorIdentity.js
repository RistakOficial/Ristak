export function normalizeTrackingVisitorId(value, maxLength = 180) {
  const cleaned = String(value || '').trim()
  return cleaned ? cleaned.slice(0, maxLength) : ''
}

export function isSuspiciousSharedVisitorId(value) {
  const cleaned = normalizeTrackingVisitorId(value)
  return /^\d{12,}$/.test(cleaned)
}

export function isTrustedTrackingVisitorId(value) {
  const cleaned = normalizeTrackingVisitorId(value)
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(cleaned)) return false
  return !isSuspiciousSharedVisitorId(cleaned)
}

export function buildFallbackVisitorIdFromSession(sessionId) {
  const sessionPart = normalizeTrackingVisitorId(sessionId, 100)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80)

  return `untrusted_${sessionPart || Date.now().toString(36)}`
}
