const SOURCE_ID_KEYS = [
  'source_id',
  'referral_source_id',
  'sourceId',
  'referralSourceId',
  'sourceID',
  'sourceid'
]

const AD_ID_KEYS = [
  'ad_id',
  'adId',
  'adID',
  'utmAdId',
  'utm_ad_id',
  'mediumId',
  'medium_id',
  'ad_id_thru_message'
]

const CTWA_KEYS = ['ctwaClid', 'ctwa_clid', 'ctwa', 'clid', 'referral_ctwa_clid']
const SOURCE_URL_KEYS = ['sourceUrl', 'source_url', 'referral_source_url']
const SOURCE_TYPE_KEYS = ['sourceType', 'source_type', 'referral_source_type']
const SOURCE_APP_KEYS = ['sourceApp', 'source_app', 'entryPointConversionApp']
const ENTRY_POINT_KEYS = [
  'entryPointConversionSource',
  'entryPointConversionExternalSource',
  'conversionSource',
  'entryPoint',
  'entry_point'
]
const HEADLINE_KEYS = ['referralHeadline', 'referral_headline', 'headline', 'title']
const BODY_KEYS = ['referralBody', 'referral_body', 'body', 'description']
const CONVERSION_DATA_KEYS = ['conversionData', 'conversion_data']
const CTWA_PAYLOAD_KEYS = ['ctwaPayload', 'ctwaSignals', 'ctwa_payload', 'ctwa_signals']

const MAX_TEXT_LENGTH = 50000
const MAX_JSON_CANDIDATES = 50

function cleanString(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function cleanAttributionId(value) {
  const cleanValue = cleanString(value)
  if (!cleanValue || cleanValue === '[object Object]') return ''
  if (cleanValue.length > 256) return ''
  return cleanValue
}

function keyMatches(key, wanted) {
  return wanted.has(String(key || '').toLowerCase())
}

export function walkAttributionPayload(value, visitor, path = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkAttributionPayload(item, visitor, [...path, String(index)], seen))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    visitor(key, child, [...path, key])
    walkAttributionPayload(child, visitor, [...path, key], seen)
  }
}

function tryParseJson(value) {
  const text = cleanString(value)
  if (!text || text.length > MAX_TEXT_LENGTH) return null

  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function extractBalancedJsonCandidates(text) {
  const candidates = []
  const source = cleanString(text)
  if (!source || source.length > MAX_TEXT_LENGTH) return candidates

  let start = -1
  let stack = []
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      if (stack.length === 0) start = index
      stack.push(char === '{' ? '}' : ']')
      continue
    }

    if ((char === '}' || char === ']') && stack.length > 0) {
      const expected = stack.pop()
      if (char !== expected) {
        stack = []
        start = -1
        continue
      }

      if (stack.length === 0 && start >= 0) {
        candidates.push(source.slice(start, index + 1))
        start = -1
        if (candidates.length >= MAX_JSON_CANDIDATES) break
      }
    }
  }

  return candidates
}

export function extractJsonPayloadsFromText(text) {
  const payloads = []
  const direct = tryParseJson(text)
  if (direct) payloads.push(direct)

  for (const candidate of extractBalancedJsonCandidates(text)) {
    const parsed = tryParseJson(candidate)
    if (parsed) payloads.push(parsed)
    if (payloads.length >= MAX_JSON_CANDIDATES) break
  }

  return payloads
}

function collectCandidateTexts(payload, extraTexts = []) {
  const texts = []
  const addText = (value) => {
    const text = cleanString(value)
    if (!text || text.length > MAX_TEXT_LENGTH) return
    if (!/[{[]|source_id|sourceId|referral_source_id|ad_id|adId|ctwa/i.test(text)) return
    texts.push(text)
  }

  extraTexts.forEach(addText)

  walkAttributionPayload(payload, (_key, value) => {
    if (typeof value === 'string') addText(value)
  })

  return [...new Set(texts)].slice(0, MAX_JSON_CANDIDATES)
}

function buildSearchRoot(payload, extraTexts = []) {
  const parsedJsonPayloads = []

  for (const text of collectCandidateTexts(payload, extraTexts)) {
    parsedJsonPayloads.push(...extractJsonPayloadsFromText(text))
    if (parsedJsonPayloads.length >= MAX_JSON_CANDIDATES) break
  }

  return {
    payload,
    parsedJsonPayloads: parsedJsonPayloads.slice(0, MAX_JSON_CANDIDATES)
  }
}

export function findFirstStringByKeys(payload, keys) {
  const wanted = new Set(keys.map(key => String(key).toLowerCase()))
  let found = ''

  walkAttributionPayload(payload, (key, value) => {
    if (found || !keyMatches(key, wanted)) return
    found = cleanString(value)
  })

  return found
}

function findFirstIdByKeyGroups(payload, keyGroups) {
  for (const keys of keyGroups) {
    const value = cleanAttributionId(findFirstStringByKeys(payload, keys))
    if (value) return value
  }

  return ''
}

export function detectWhatsAppAttributionFields(payload, extraTexts = []) {
  const searchRoot = buildSearchRoot(payload, extraTexts)

  return {
    ctwaClid: findFirstStringByKeys(searchRoot, CTWA_KEYS),
    sourceId: findFirstIdByKeyGroups(searchRoot, [SOURCE_ID_KEYS, AD_ID_KEYS]),
    sourceUrl: findFirstStringByKeys(searchRoot, SOURCE_URL_KEYS),
    sourceType: findFirstStringByKeys(searchRoot, SOURCE_TYPE_KEYS),
    sourceApp: findFirstStringByKeys(searchRoot, SOURCE_APP_KEYS),
    entryPoint: findFirstStringByKeys(searchRoot, ENTRY_POINT_KEYS),
    headline: findFirstStringByKeys(searchRoot, HEADLINE_KEYS),
    body: findFirstStringByKeys(searchRoot, BODY_KEYS),
    conversionData: findFirstStringByKeys(searchRoot, CONVERSION_DATA_KEYS),
    ctwaPayload: findFirstStringByKeys(searchRoot, CTWA_PAYLOAD_KEYS)
  }
}
