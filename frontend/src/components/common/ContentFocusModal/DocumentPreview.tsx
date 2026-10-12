import React, { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { Button } from '../Button'
import { Loading } from '../Loading'
import { getApiBaseUrl } from '@/services/apiBaseUrl'
import { decodeDocumentText, documentArchiveText, documentPreviewKind, documentRequestHeaders,
  hasPdfSignature, readDocumentArchive, readDocumentBytes, type DocumentPreviewKind } from './documentPreviewUtils'
import styles from './DocumentPreview.module.css'
import { useContentFocusSpace } from './useContentFocusSpace'

interface DocumentPreviewProps {
  url: string
  title: string
  mimeType?: string
  onFileReady: (source: string, downloadUrl: string) => void
}
type Preview = { kind: DocumentPreviewKind; bytes: Uint8Array; text?: string; truncated?: boolean }

function PreviewNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className={styles.notice} role="status">
    <FileText size={32} aria-hidden="true" />
    <p>{message}</p>
    {retry ? <Button variant="secondary" size="sm" onClick={retry} leftIcon={<RotateCcw size={15} />}>Reintentar</Button> : null}
  </div>
}

export function DocumentPreview({ url, title, mimeType = '', onFileReady }: DocumentPreviewProps) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setPreview(null)
    setError('')
    const load = async () => {
      try {
        const appOrigin = getApiBaseUrl() || location.origin
        let token = ''
        try { token = localStorage.getItem('auth_token') || '' } catch { /* Restricted storage. */ }
        const result = await readDocumentBytes(url, controller.signal, documentRequestHeaders(url, appOrigin, token))
        if (controller.signal.aborted) return
        const declaredKind = documentPreviewKind(mimeType, title, url)
        const kind = hasPdfSignature(result.bytes) ? 'pdf' : declaredKind === 'unsupported'
          ? documentPreviewKind(result.mimeType, title, url) : declaredKind
        // Never give an active HTML/XML/SVG attachment the app's blob origin.
        const blobMime = kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain' : 'application/octet-stream'
        objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: blobMime }))
        onFileReady(url, objectUrl)
        let text: { text: string; truncated: boolean } | undefined
        if (kind === 'text') text = decodeDocumentText(result.bytes)
        else if (['docx', 'xlsx', 'pptx', 'odf', 'zip'].includes(kind)) {
          text = documentArchiveText(await readDocumentArchive(result.bytes, kind, controller.signal), kind)
        }
        if (!controller.signal.aborted) setPreview({ ...text, kind, bytes: result.bytes })
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error && failure.name !== 'AbortError'
          ? failure.message : 'La carga tardó demasiado. Intenta de nuevo o descarga el original.')
      }
    }
    void load()
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); onFileReady(url, '') }
  }, [url, title, mimeType, attempt, onFileReady])

  if (error) return <PreviewNotice message={error} retry={() => setAttempt(value => value + 1)} />
  if (!preview) return <Loading compact message="Cargando vista previa…" />
  if (preview.kind === 'pdf') return <PdfPreview bytes={preview.bytes} title={title} />
  if (preview.kind === 'unsupported') return <PreviewNotice message="Este formato no tiene una vista previa de contenido. Puedes descargar el archivo original para abrirlo con su aplicación." />
  const note = preview.kind === 'zip' ? 'Archivos incluidos en el ZIP. No se ejecuta ni abre su contenido.'
    : preview.kind === 'xlsx' ? 'Vista de valores sin formato: hasta 5 hojas y 500 filas por hoja. Descarga el original para ver fórmulas, fechas y estilos completos.'
      : ['docx', 'pptx', 'odf'].includes(preview.kind) ? 'Vista del texto. El original conserva el diseño, las imágenes y los demás elementos.' : ''
  return <div className={styles.document}>
    {note ? <p className={styles.note}>{note}</p> : null}
    <pre className={styles.text} tabIndex={0} aria-label={`Contenido de ${title}`}>{preview.text || 'El documento no contiene texto.'}</pre>
    {preview.truncated ? <p className={styles.note}>Se muestra una parte del documento. Descarga el original para consultar el resto.</p> : null}
  </div>
}

function PdfPreview({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [showText, setShowText] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const space = useContentFocusSpace(viewportRef, true, true)
  useEffect(() => {
    let active = true
    let timedOut = false
    let task: PDFDocumentLoadingTask | undefined
    const timer = setTimeout(() => {
      timedOut = true
      if (active) {
        setBusy(false)
        setError('El PDF tardó demasiado en abrirse. Descarga el original para consultarlo.')
        void task?.destroy().catch(() => {})
      }
    }, 30_000)
    const load = async () => {
      try {
        const [renderer, worker] = await Promise.all([
          import('pdfjs-dist/legacy/build/pdf.mjs'),
          import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
        ])
        if (!active || timedOut) return
        renderer.GlobalWorkerOptions.workerSrc = worker.default
        const assets = `${import.meta.env.BASE_URL}pdfjs/`
        task = renderer.getDocument({ data: bytes.slice(), enableXfa: false, maxImageSize: 16_000_000,
          cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` })
        const document = await task.promise
        if (active && !timedOut) setPdf(document)
      } catch (failure) {
        if (active && !timedOut) setError(failure instanceof Error && failure.name === 'PasswordException'
          ? 'El PDF está protegido con contraseña. Descarga el original para abrirlo.'
          : 'No se pudo leer este PDF. El archivo original sigue disponible para descargar.')
      } finally { clearTimeout(timer) }
    }
    void load()
    return () => { active = false; clearTimeout(timer); void task?.destroy().catch(() => {}) }
  }, [bytes])
  useEffect(() => {
    if (!pdf) return
    let active = true
    let timedOut = false
    let render: RenderTask | undefined
    const timer = setTimeout(() => {
      timedOut = true
      render?.cancel()
      if (active) {
        setBusy(false)
        setError('Esta página tardó demasiado en mostrarse. Puedes cambiar de página o descargar el original.')
      }
    }, 30_000)
    setBusy(true)
    setError('')
    const draw = async () => {
      try {
        const documentPage = await pdf.getPage(page)
        const canvas = canvasRef.current
        if (!active || timedOut || !canvas) return
        const natural = documentPage.getViewport({ scale: 1 })
        const scale = Math.min(1, space.width / natural.width, space.height / natural.height) * zoom
        const viewport = documentPage.getViewport({ scale })
        const resolution = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (viewport.width * viewport.height)))
        canvas.width = Math.max(1, Math.floor(viewport.width * resolution))
        canvas.height = Math.max(1, Math.floor(viewport.height * resolution))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas no disponible')
        render = documentPage.render({ canvas, canvasContext: context, viewport, transform: [resolution, 0, 0, resolution, 0, 0] })
        await render.promise
        const content = await documentPage.getTextContent().catch(() => null)
        if (active && !timedOut) {
          setText(content?.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, 150_000) || '')
          setBusy(false)
        }
      } catch (failure) {
        if (active && !timedOut && !(failure instanceof Error && failure.name === 'RenderingCancelledException')) {
          setBusy(false)
          setError('No se pudo mostrar esta página. Puedes cambiar de página o descargar el original.')
        }
      } finally { clearTimeout(timer) }
    }
    void draw()
    return () => { active = false; clearTimeout(timer); render?.cancel() }
  }, [pdf, page, zoom, space])

  return <div className={`${styles.document} ${styles.pdfDocument}`}>
    <div className={styles.toolbar} aria-label="Controles del PDF">
      <Button variant="ghost" size="sm" iconOnly aria-label="Página anterior" disabled={!pdf || page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></Button>
      <span className={styles.pageNumber} aria-live="polite">Página {page} de {pdf?.numPages || '…'}</span>
      <Button variant="ghost" size="sm" iconOnly aria-label="Página siguiente" disabled={!pdf || page >= pdf.numPages || busy} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></Button>
      <span className={styles.toolbarSpacer} />
      <Button variant="ghost" size="sm" iconOnly aria-label="Alejar" disabled={!pdf || zoom <= 0.5 || busy} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><ZoomOut size={18} /></Button>
      <Button variant="ghost" size="sm" iconOnly aria-label="Acercar" disabled={!pdf || zoom >= 2 || busy} onClick={() => setZoom(value => Math.min(2, value + 0.25))}><ZoomIn size={18} /></Button>
      <Button variant="ghost" size="sm" disabled={!pdf || busy} onClick={() => setShowText(value => !value)}>{showText ? 'Ver PDF' : 'Ver texto'}</Button>
    </div>
    <div className={styles.pdfViewport} ref={viewportRef} aria-busy={busy}>
      {error ? <PreviewNotice message={error} /> : busy ? <div className={styles.pdfStatus}><Loading compact message="Preparando página…" /></div> : null}
      <canvas ref={canvasRef} className={styles.pdfCanvas} hidden={Boolean(error) || showText} data-loading={busy ? 'true' : undefined} role="img" aria-label={`${title}, página ${page}`} />
      {showText && !error ? <pre className={styles.text} data-loading={busy ? 'true' : undefined} tabIndex={0} aria-label={`Texto de la página ${page}`}>{text || 'Esta página contiene imágenes o texto escaneado. Usa Ver PDF para consultarla.'}</pre> : null}
    </div>
  </div>
}
