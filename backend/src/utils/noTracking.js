const QUERY_FLAG_KEYS = [
  'no_track',
  'noTrack',
  'notrack',
  'rstk_no_track',
  'rstkNoTrack',
  'rstk_preview',
  'rstkPreview',
  'preview',
  'editor',
  'editor_preview',
  'editorPreview'
]

const PAYLOAD_FLAG_KEYS = [
  ...QUERY_FLAG_KEYS,
  'previewSession',
  'preview_session',
  'trackingDisabled',
  'tracking_disabled',
  'trackingMode',
  'tracking_mode'
]

const NO_TRACK_VALUES = new Set([
  '',
  '1',
  'true',
  'yes',
  'y',
  'on',
  'preview',
  'editor',
  'test',
  'no_track',
  'notrack',
  'disabled',
  'disable',
  'off'
])

const LIVE_TRACKING_VALUES = new Set([
  'live',
  'public',
  'published',
  'production',
  'track',
  'tracked'
])

export const NO_TRACK_REASON = 'preview_no_track'

function cleanFlagValue(value) {
  return String(value ?? '').trim().toLowerCase()
}

function flagValueMeansNoTrack(value, { allowZeroFalse = true } = {}) {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return false

  const cleaned = cleanFlagValue(value)
  if (LIVE_TRACKING_VALUES.has(cleaned)) return false
  if (allowZeroFalse && (cleaned === '0' || cleaned === 'false' || cleaned === 'no')) return false
  return NO_TRACK_VALUES.has(cleaned)
}

function trackingParamMeansNoTrack(value) {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return false

  const cleaned = cleanFlagValue(value)
  if (LIVE_TRACKING_VALUES.has(cleaned)) return false

  // Backwards compatible with the existing Sites bypass where ?tracking=true
  // meant "tracking preview/test mode" instead of "enable tracking".
  return NO_TRACK_VALUES.has(cleaned) || cleaned === '0' || cleaned === 'false' || cleaned === 'no'
}

function anyValueMeansNoTrack(value, checker = flagValueMeansNoTrack) {
  if (Array.isArray(value)) return value.some(item => checker(item))
  return checker(value)
}

export function searchParamsHaveNoTrack(searchParams) {
  if (!searchParams) return false

  for (const key of QUERY_FLAG_KEYS) {
    if (!searchParams.has(key)) continue
    if (anyValueMeansNoTrack(searchParams.getAll(key))) return true
  }

  if (searchParams.has('tracking')) {
    return anyValueMeansNoTrack(searchParams.getAll('tracking'), trackingParamMeansNoTrack)
  }

  return false
}

function objectHasNoTrackFlag(value = {}) {
  if (!value || typeof value !== 'object') return false

  for (const key of PAYLOAD_FLAG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (anyValueMeansNoTrack(value[key], key === 'tracking' ? trackingParamMeansNoTrack : flagValueMeansNoTrack)) {
      return true
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'tracking')) {
    return anyValueMeansNoTrack(value.tracking, trackingParamMeansNoTrack)
  }

  return false
}

export function urlHasNoTrack(value) {
  const raw = String(value || '').trim()
  if (!raw) return false

  try {
    return searchParamsHaveNoTrack(new URL(raw, 'https://rstk.local').searchParams)
  } catch {
    return false
  }
}

export function requestHasNoTrack(req = {}) {
  if (!req || typeof req !== 'object') return false

  if (objectHasNoTrackFlag(req.query || {})) return true
  if (objectHasNoTrackFlag(req.body || {})) return true

  const headers = req.headers || {}
  if (
    flagValueMeansNoTrack(headers['x-rstk-no-track']) ||
    flagValueMeansNoTrack(headers['x-ristak-no-track']) ||
    flagValueMeansNoTrack(headers['x-rstk-preview']) ||
    flagValueMeansNoTrack(headers['x-ristak-preview'])
  ) {
    return true
  }

  return urlHasNoTrack(req.originalUrl || req.url || '')
}

function payloadUrlsHaveNoTrack(value = {}) {
  if (!value || typeof value !== 'object') return false
  return urlHasNoTrack(value.url) || urlHasNoTrack(value.referrer) || urlHasNoTrack(value.pageUrl)
}

export function payloadHasNoTrack(value = {}) {
  if (!value || typeof value !== 'object') return false

  if (objectHasNoTrackFlag(value)) return true
  if (objectHasNoTrackFlag(value.meta || {})) return true
  if (objectHasNoTrackFlag(value.data || {})) return true
  if (payloadUrlsHaveNoTrack(value.meta || {})) return true
  if (payloadUrlsHaveNoTrack(value.data || {})) return true

  const data = value.data && typeof value.data === 'object' ? value.data : value
  return payloadUrlsHaveNoTrack(data)
}

export function getNoTrackReason({ req, body, data, meta, previewContext } = {}) {
  if (previewContext) return NO_TRACK_REASON
  if (requestHasNoTrack(req)) return NO_TRACK_REASON
  if (payloadHasNoTrack(body)) return NO_TRACK_REASON
  if (payloadHasNoTrack(data)) return NO_TRACK_REASON
  if (payloadHasNoTrack(meta)) return NO_TRACK_REASON
  return ''
}

export function shouldSkipTracking(input = {}) {
  return Boolean(getNoTrackReason(input))
}
