import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'
import sharp from 'sharp'

// A separate OS process isolates native decoder failures from the HTTP server.
const workerData = await new Promise(resolve => process.once('message', resolve))
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
try {
  const buffer = Buffer.from(workerData.bytes)
  if (workerData.kind === 'image') {
    const image = await sharp(buffer, { limitInputPixels: 40_000_000, animated: false })
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer()
    process.send({ images: [{ page: 1, mimeType: 'image/jpeg', data: image.toString('base64') }] })
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false,
      useSystemFonts: true, disableFontFace: true, stopAtErrors: true,
      maxImageSize: 16_000_000, isOffscreenCanvasSupported: false })
    const pdf = await task.promise
    try {
      const firstPage = workerData.page
      if (firstPage > pdf.numPages) throw new Error('La página solicitada no existe.')
      const lastPage = Math.min(pdf.numPages, firstPage + workerData.pageCount - 1)
      const images = []
      const texts = []
      for (let index = firstPage; index <= lastPage; index += 1) {
        const page = await pdf.getPage(index)
        const natural = page.getViewport({ scale: 1 })
        const scale = Math.min(2, 1600 / Math.max(natural.width, natural.height))
        const viewport = page.getViewport({ scale })
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
        const image = canvas.toBuffer('image/jpeg', 85)
        images.push({ page: index, mimeType: 'image/jpeg', data: image.toString('base64') })
        const content = await page.getTextContent()
        texts.push({ page: index, text: content.items.map(item => item.str ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, 16000) })
        page.cleanup()
      }
      process.send({ images, texts, pageCount: pdf.numPages, firstPage, lastPage,
        hasMore: lastPage < pdf.numPages })
    } finally {
      await task.destroy()
    }
  }
} catch (error) {
  process.send({ error: error.name === 'PasswordException'
    ? 'El PDF está protegido con contraseña. Descarga el original para abrirlo.'
    : 'No se pudo generar la vista previa. El archivo original sigue disponible.', code: error.name })
}
