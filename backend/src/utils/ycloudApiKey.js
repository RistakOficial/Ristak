function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function normalizeYCloudApiKeyInput(value) {
  let text = cleanString(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (!text) return ''

  const structuredMatch = text.match(/["']?(?:x-api-key|apiKey|api_key)["']?\s*[:=]\s*["']([^"']+)["']/i)
  if (structuredMatch?.[1]) {
    text = structuredMatch[1]
  } else {
    const headerMatch = text.match(/(?:x-api-key\s*:|authorization\s*:\s*bearer\s+)\s*([^'"\r\n]+)/i)
    if (headerMatch?.[1]) text = headerMatch[1]
  }

  return text
    .replace(/^\s*(?:-H|--header)\s+['"]?/i, '')
    .replace(/^authorization\s*:\s*bearer\s+/i, '')
    .replace(/^x-api-key\s*:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .replace(/^['"`]+|['"`,\s]+$/g, '')
    .trim()
}
