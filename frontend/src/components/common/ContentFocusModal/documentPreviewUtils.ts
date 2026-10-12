export type DocumentPreviewKind = 'pdf' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'odf' | 'zip' | 'unsupported'

export const DOCUMENT_PREVIEW_MAX_BYTES = 20 * 1024 * 1024
export const DOCUMENT_PREVIEW_MAX_TEXT = 150_000

const extensions: Record<string, DocumentPreviewKind> = {
  pdf: 'pdf', txt: 'text', csv: 'text', tsv: 'text', json: 'text', xml: 'text',
  md: 'text', log: 'text', yaml: 'text', yml: 'text', html: 'text', htm: 'text',
  docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', odt: 'odf', ods: 'odf', odp: 'odf', zip: 'zip'
}
const mimes: Record<string, DocumentPreviewKind> = {
  'application/pdf': 'pdf', 'application/json': 'text', 'application/xml': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odf',
  'application/vnd.oasis.opendocument.spreadsheet': 'odf',
  'application/vnd.oasis.opendocument.presentation': 'odf',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip'
}

export function documentPreviewKind(mimeType = '', filename = '', url = ''): DocumentPreviewKind {
  const mime = mimeType.split(';')[0].trim().toLowerCase()
  const extension = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  // Some storage providers describe every Office container as ZIP or binary.
  if (['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(mime) && extensions[extension]) return extensions[extension]
  if (mimes[mime]) return mimes[mime]
  if (mime.startsWith('text/')) return 'text'
  return extensions[extension] || 'unsupported'
}

export function documentActionUrl(url: string, baseOrigin: string): string | undefined {
  try {
    const parsed = new URL(url, baseOrigin)
    return ['http:', 'https:', 'blob:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : undefined
  } catch { return undefined }
}

export function hasPdfSignature(bytes: Uint8Array) {
  return new TextDecoder('ascii').decode(bytes.subarray(0, 1024)).includes('%PDF-')
}

export function decodeDocumentText(bytes: Uint8Array): { text: string; truncated: boolean } {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  else {
    const declaration = new TextDecoder().decode(bytes.subarray(0, 200)).match(/<\?xml[^>]*encoding=["']([^"']+)/i)?.[1]?.toLowerCase()
    if (declaration && ['iso-8859-1', 'windows-1252', 'utf-16', 'utf-16le', 'utf-16be'].includes(declaration)) encoding = declaration
  }
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { text = new TextDecoder('windows-1252').decode(bytes) }
  return { text: text.slice(0, DOCUMENT_PREVIEW_MAX_TEXT), truncated: text.length > DOCUMENT_PREVIEW_MAX_TEXT }
}

/** Tokens only accompany the app's authenticated asset route, never a CDN or an arbitrary URL. */
export function documentRequestHeaders(url: string, appOrigin: string, token = ''): HeadersInit {
  const target = new URL(url, appOrigin)
  return token && target.origin === new URL(appOrigin).origin && /^\/api\/media\/assets\/[^/]+\/download$/.test(target.pathname)
    ? { Authorization: `Bearer ${token}` } : {}
}

export async function readDocumentBytes(url: string, signal: AbortSignal, headers: HeadersInit = {}) {
  const parsed = new URL(url, typeof location === 'undefined' ? 'https://localhost' : location.href)
  if (!['https:', 'http:', 'blob:', 'data:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('El enlace del documento no es válido.')
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 30_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(url, { signal: controller.signal, headers, credentials: 'same-origin',
      redirect: new Headers(headers).has('Authorization') ? 'error' : 'follow' })
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? 'No tienes acceso a este documento. Vuelve a iniciar sesión o revisa tus permisos.'
        : response.status === 404 ? 'El documento ya no está disponible.' : 'No se pudo cargar el documento. Intenta de nuevo.')
    }
    const declaredSize = Number(response.headers.get('Content-Length'))
    const tooLarge = () => new Error('Este archivo supera los 20 MB de vista previa. Puedes descargar el original.')
    if (declaredSize > DOCUMENT_PREVIEW_MAX_BYTES) { await response.body?.cancel(); throw tooLarge() }
    if (!response.body) throw new Error('No se pudo leer el documento.')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DOCUMENT_PREVIEW_MAX_BYTES) throw tooLarge()
      chunks.push(value)
    }
    if (!size) throw new Error('El documento está vacío.')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { bytes, mimeType: response.headers.get('Content-Type')?.split(';')[0].trim() || '' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    controller.abort()
  }
}

export interface DocumentArchiveContent { files: Record<string, string>; names: string[]; namesTruncated: boolean }

export function readDocumentArchive(bytes: Uint8Array, kind: DocumentPreviewKind, signal: AbortSignal): Promise<DocumentArchiveContent> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./documentArchive.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: Error, result?: DocumentArchiveContent) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new DOMException('Cancelado', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('El archivo tardó demasiado en procesarse. Descarga el original.')), 15_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : undefined, data)
    worker.onerror = () => finish(new Error('No se pudo leer este formato. El archivo original sigue disponible.'))
    if (signal.aborted) abort()
    else worker.postMessage({ bytes, kind })
  })
}

function xmlDocument(value = '') {
  if (!value || /<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('No se pudo leer el contenido de este documento.')
  const xml = new DOMParser().parseFromString(value, 'application/xml')
  if (xml.getElementsByTagName('parsererror').length) throw new Error('El documento no tiene un formato válido.')
  return xml
}
const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name))
const paragraphText = (xml: Document) => elements(xml, 'p').map(p => elements(p, 't').map(t => t.textContent || '').join('')).filter(Boolean).join('\n\n')

/** OOXML/OpenDocument content is displayed as escaped text. Relationships, macros and links never run. */
export function documentArchiveText(content: DocumentArchiveContent, kind: DocumentPreviewKind) {
  let text = ''
  if (kind === 'zip') text = content.names.join('\n')
  else if (kind === 'docx') text = paragraphText(xmlDocument(content.files['word/document.xml']))
  else if (kind === 'pptx') {
    text = Object.keys(content.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]))
      .map(name => `Diapositiva ${name.match(/slide(\d+)/)?.[1]}\n\n${paragraphText(xmlDocument(content.files[name]))}`).join('\n\n────────\n\n')
  } else if (kind === 'xlsx') {
    const shared = content.files['xl/sharedStrings.xml']
      ? elements(xmlDocument(content.files['xl/sharedStrings.xml']), 'si').map(si => elements(si, 't').map(t => t.textContent || '').join('')) : []
    const workbook = content.files['xl/workbook.xml'] ? xmlDocument(content.files['xl/workbook.xml']) : null
    const rels = content.files['xl/_rels/workbook.xml.rels'] ? elements(xmlDocument(content.files['xl/_rels/workbook.xml.rels']), 'Relationship') : []
    const sheetNames = new Map<string, string>()
    for (const sheet of workbook ? elements(workbook, 'sheet') : []) {
      const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      const target = rels.find(rel => rel.getAttribute('Id') === id)?.getAttribute('Target') || ''
      const name = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
      sheetNames.set(name, sheet.getAttribute('name') || 'Hoja')
    }
    text = Object.keys(content.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1]))
      .map(name => {
        const rows = elements(xmlDocument(content.files[name]), 'row')
        const values = rows.slice(0, 500).map(row => elements(row, 'c').slice(0, 50).map(cell => {
          const value = elements(cell, 'v')[0]?.textContent || ''
          const type = cell.getAttribute('t')
          const result = type === 's' ? shared[Number(value)] || '' : type === 'inlineStr'
            ? elements(cell, 't').map(t => t.textContent || '').join('') : value
          return `${cell.getAttribute('r') || ''}: ${result}`
        }).join(' · ')).join('\n')
        return `${sheetNames.get(name) || `Hoja ${name.match(/sheet(\d+)/)?.[1]}`}\n\n${values}${rows.length > 500 ? '\n… Más filas en el original.' : ''}`
      }).join('\n\n────────\n\n')
  } else if (kind === 'odf') {
    const xml = xmlDocument(content.files['content.xml'])
    text = elements(xml, 'p').map(p => p.textContent || '').filter(Boolean).join('\n\n')
  }
  if (!text.trim()) throw new Error('Este documento no contiene texto para mostrar. Descarga el original para revisar imágenes u otros elementos.')
  return { text: text.slice(0, DOCUMENT_PREVIEW_MAX_TEXT), truncated: text.length > DOCUMENT_PREVIEW_MAX_TEXT || content.namesTruncated }
}
