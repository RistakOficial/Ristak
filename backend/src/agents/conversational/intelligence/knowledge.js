const STOP_WORDS = new Set([
  'para', 'como', 'pero', 'porque', 'cuando', 'donde', 'desde', 'hasta', 'sobre',
  'este', 'esta', 'estos', 'estas', 'tiene', 'tienen', 'quiero', 'necesito',
  'hola', 'gracias', 'favor', 'puedo', 'puede', 'cual', 'cuanto', 'algo', 'todo'
])

function cleanText(value, maxLength = 6000) {
  return String(value ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, maxLength)
}

function tokens(value = '') {
  return new Set((cleanText(value, 4000)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) || [])
    .filter((token) => !STOP_WORDS.has(token)))
}

function flattenStrings(value, prefix = '', output = [], depth = 0) {
  if (output.length >= 120 || depth > 5 || value === null || value === undefined) return output
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = cleanText(value, 1600)
    if (text) output.push(prefix ? `${prefix}: ${text}` : text)
    return output
  }
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((item) => flattenStrings(item, prefix, output, depth + 1))
    return output
  }
  if (typeof value === 'object') {
    Object.entries(value).slice(0, 60).forEach(([key, item]) => {
      if (/(?:secret|token|password|api.?key|private.?key)/i.test(key)) return
      flattenStrings(item, prefix ? `${prefix}.${key}` : key, output, depth + 1)
    })
  }
  return output
}

function splitContext(value = '') {
  return cleanText(value, 30000)
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/)
    .map((item) => cleanText(item, 1600))
    .filter((item) => item.length >= 12)
    .slice(0, 120)
}

function scoreChunk(chunk, queryTokens) {
  if (!queryTokens.size) return 0
  const chunkTokens = tokens(chunk)
  let overlap = 0
  for (const token of queryTokens) if (chunkTokens.has(token)) overlap += 1
  return overlap / Math.max(1, Math.sqrt(chunkTokens.size))
}

function uniqueChunks(chunks = []) {
  const seen = new Set()
  return chunks.filter((chunk) => {
    const key = cleanText(chunk, 1800).toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function retrieveRelevantBusinessKnowledge({
  businessProfile = null,
  fallbackContext = '',
  query = '',
  maxChars = 6000,
  maxChunks = 10
} = {}) {
  const summary = cleanText(businessProfile?.summary, 1800)
  const structured = flattenStrings(businessProfile?.profile || {})
  const sourceChunks = splitContext(businessProfile?.sourceContext || fallbackContext)
  const chunks = uniqueChunks([
    ...structured,
    ...sourceChunks
  ])
  const queryTokens = tokens(query)
  const summaryScore = scoreChunk(summary, queryTokens)
  const ranked = chunks
    .map((text, index) => ({ text, index, score: scoreChunk(text, queryTokens) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))

  const positive = ranked.filter((item) => item.score > 0)
  const found = queryTokens.size === 0
    ? Boolean(summary || ranked.length)
    : summaryScore > 0 || positive.length > 0
  const chosen = (queryTokens.size ? positive : ranked).slice(0, Math.max(1, maxChunks))
  const lines = found
    ? uniqueChunks([
        (!queryTokens.size || summaryScore > 0) ? summary : '',
        ...chosen.map((item) => item.text)
      ])
    : []
  const selected = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 2 > maxChars) continue
    selected.push(line)
    used += line.length + 2
  }

  return {
    context: selected.join('\n\n'),
    found,
    confidence: !found ? 0 : Math.min(1, Math.max(summaryScore, chosen[0]?.score || 0, queryTokens.size ? 0.25 : 0.5)),
    source: businessProfile?.configured ? 'business_profile' : fallbackContext ? 'legacy_business_context' : 'empty',
    version: businessProfile?.sourceHash || businessProfile?.updatedAt || null,
    citations: selected.length ? [{ source: businessProfile?.configured ? 'business_profile' : 'legacy_business_context', version: businessProfile?.sourceHash || null }] : [],
    queryTokens: [...queryTokens].slice(0, 30),
    selectedChunks: selected.length,
    totalChunks: chunks.length
  }
}
