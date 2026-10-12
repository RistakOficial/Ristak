import test from 'node:test'
import assert from 'node:assert/strict'
import { documentPreviewKind, documentActionUrl, hasPdfSignature, decodeDocumentText, documentRequestHeaders,
  readDocumentBytes, DOCUMENT_PREVIEW_MAX_BYTES, DOCUMENT_PREVIEW_MAX_TEXT } from '../src/components/common/ContentFocusModal/documentPreviewUtils.ts'

test('identifica documentos por MIME o extensión exacta, no por la palabra pdf en el título', () => {
  assert.equal(documentPreviewKind('application/pdf; charset=binary'), 'pdf')
  assert.equal(documentPreviewKind('', 'FACTURA.PDF'), 'pdf')
  assert.equal(documentPreviewKind('', '', 'https://cdn.example/file.pdf?download=1'), 'pdf')
  assert.equal(documentPreviewKind('', 'notas sobre pdf.exe'), 'unsupported')
  assert.equal(documentPreviewKind('text/html', 'archivo.html'), 'text')
  assert.equal(documentPreviewKind('application/xml'), 'text')
  for (const ext of ['docx', 'xlsx', 'pptx', 'zip']) assert.equal(documentPreviewKind('', `archivo.${ext}`), ext)
  assert.equal(documentPreviewKind('application/zip', 'archivo.docx'), 'docx')
  assert.equal(documentPreviewKind('application/octet-stream', 'archivo.xlsx'), 'xlsx')
  for (const ext of ['odt', 'ods', 'odp']) assert.equal(documentPreviewKind('', `archivo.${ext}`), 'odf')
  assert.equal(documentPreviewKind('application/octet-stream', 'archivo.doc'), 'unsupported')
  assert.equal(hasPdfSignature(new TextEncoder().encode('%PDF-1.7\n')), true)
  assert.equal(hasPdfSignature(new TextEncoder().encode('<html>documento</html>')), false)
})

test('conserva UTF-8, UTF-16 y XML Latin-1 y avisa cuando el texto está recortado', () => {
  const text = 'México, niño y canción 🇲🇽'
  assert.equal(decodeDocumentText(new TextEncoder().encode(text)).text, text)
  assert.equal(decodeDocumentText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Canción', 'utf16le')])).text, 'Canción')
  assert.equal(decodeDocumentText(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><texto>niño</texto>', 'latin1')).text.includes('niño'), true)
  const result = decodeDocumentText(new TextEncoder().encode('a'.repeat(DOCUMENT_PREVIEW_MAX_TEXT + 1)))
  assert.equal(result.text.length, DOCUMENT_PREVIEW_MAX_TEXT)
  assert.equal(result.truncated, true)
  assert.equal(decodeDocumentText(new TextEncoder().encode('<script>no ejecutar</script>')).text, '<script>no ejecutar</script>')
})

test('la autenticación sólo acompaña descargas de Media del origen de la instalación', () => {
  assert.deepEqual(documentRequestHeaders('/api/media/assets/asset/download', 'https://app.example', 'test-only'), { Authorization: 'Bearer test-only' })
  assert.deepEqual(documentRequestHeaders('https://cdn.example/file.pdf', 'https://app.example', 'test-only'), {})
  assert.deepEqual(documentRequestHeaders('https://other.example/api/media/assets/asset/download', 'https://app.example', 'test-only'), {})
  assert.deepEqual(documentRequestHeaders('/api/other/secret', 'https://app.example', 'test-only'), {})
  assert.deepEqual(documentRequestHeaders('/media/assets/asset/file', 'https://app.example', 'test-only'), {})
  assert.equal(documentActionUrl('javascript:alert(1)', 'https://app.example'), undefined)
  assert.equal(documentActionUrl('data:text/html,<script>1</script>', 'https://app.example'), undefined)
  assert.equal(documentActionUrl('https://username:password@cdn.example/file.pdf', 'https://app.example'), undefined)
  assert.equal(documentActionUrl('/file.pdf', 'https://app.example'), '/file.pdf')
})

test('lee bytes y MIME del documento sin perder caracteres ni tocar el contenido', async t => {
  const bytes = new TextEncoder().encode('Prueba de documento')
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.redirect, 'follow')
    return new Response(bytes, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  })
  const result = await readDocumentBytes('https://cdn.example/prueba.txt', new AbortController().signal)
  assert.deepEqual(result.bytes, bytes)
  assert.equal(result.mimeType, 'text/plain')
})

test('cancela una respuesta demasiado grande antes de leer el cuerpo', async t => {
  let cancelled = false
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'Content-Length': String(DOCUMENT_PREVIEW_MAX_BYTES + 1) } }))
  await assert.rejects(readDocumentBytes('https://cdn.example/grande.pdf', new AbortController().signal), /20 MB/)
  assert.equal(cancelled, true)
})

test('el límite también se aplica al tamaño real cuando no se declara Content-Length', async t => {
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true }
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream))
  await assert.rejects(readDocumentBytes('https://cdn.example/grande.pdf', new AbortController().signal), /20 MB/)
  assert.equal(cancelled, true)
})

test('un permiso denegado y un archivo vacío producen errores claros', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response('', { status: 403 })
  })
  await assert.rejects(readDocumentBytes('https://app.example/api/media/assets/asset/download', new AbortController().signal, new Headers({ Authorization: 'Bearer test-only' })), /No tienes acceso/)
  mock.mock.mockImplementation(async () => new Response(''))
  await assert.rejects(readDocumentBytes('https://cdn.example/vacio.txt', new AbortController().signal), /vacío/)
})

test('rechaza enlaces activos y cancela una lectura en curso al cerrar el visor', async t => {
  await assert.rejects(readDocumentBytes('javascript:alert(1)', new AbortController().signal), /no es válido/)
  const abort = new AbortController()
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), { once: true })
  }))
  const read = readDocumentBytes('https://cdn.example/lento.pdf', abort.signal)
  abort.abort()
  await assert.rejects(read, { name: 'AbortError' })
})
