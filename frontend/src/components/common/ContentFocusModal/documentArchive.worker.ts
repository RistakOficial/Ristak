import { Unzip, UnzipInflate } from 'fflate'
import type { DocumentPreviewKind } from './documentPreviewUtils'

// Decompression lives in a disposable worker with byte, part, entry and time limits.
self.onmessage = ({ data }: MessageEvent<{ bytes: Uint8Array; kind: DocumentPreviewKind }>) => {
  const files: Record<string, string> = Object.create(null)
  const names: string[] = []
  let entries = 0
  let namedFiles = 0
  let parts = 0
  let totalBytes = 0
  let failed = false
  const fail = () => {
    if (failed) return
    failed = true
    self.postMessage({ error: 'El documento es demasiado complejo o no se puede leer. Descarga el original.' })
  }
  const wanted = (name: string) => data.kind === 'docx' ? name === 'word/document.xml'
    : data.kind === 'xlsx' ? ['xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].includes(name) || /^xl\/worksheets\/sheet[1-5]\.xml$/.test(name)
      : data.kind === 'pptx' ? /^ppt\/slides\/slide\d+\.xml$/.test(name) && Number(name.match(/slide(\d+)/)?.[1]) <= 50
        : data.kind === 'odf' && name === 'content.xml'
  const unzip = new Unzip(file => {
    entries += 1
    if (entries > 2000 || file.name.length > 1000) { fail(); return }
    if (!file.name.endsWith('/')) {
      namedFiles += 1
      if (names.length < 100) names.push(file.name)
    }
    if (!wanted(file.name) || failed) return
    parts += 1
    if (parts > 60 || (file.originalSize || 0) > 2 * 1024 * 1024 || Object.prototype.hasOwnProperty.call(files, file.name)) { fail(); return }
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, bytes, final) => {
      if (error || failed) { file.terminate(); fail(); return }
      size += bytes.length
      totalBytes += bytes.length
      if (size > 2 * 1024 * 1024 || totalBytes > 8 * 1024 * 1024) { file.terminate(); fail(); return }
      chunks.push(bytes)
      if (final) {
        const output = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
        files[file.name] = new TextDecoder('utf-8', { fatal: true }).decode(output)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < data.bytes.length && !failed; offset += 4096) {
      unzip.push(data.bytes.subarray(offset, offset + 4096), offset + 4096 >= data.bytes.length)
    }
    if (!failed) self.postMessage({ files, names, namesTruncated: namedFiles > names.length })
  } catch { fail() }
}
