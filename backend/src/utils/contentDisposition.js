export function safeHeaderFilename(value = '', fallback = 'media') {
  const filename = String(value || fallback)
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001F\u007F-\u009F"]/g, '')
    .trim()
  return filename || fallback
}

export function attachmentDisposition(filename = '', fallback = 'media') {
  const safe = safeHeaderFilename(filename, fallback)
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
