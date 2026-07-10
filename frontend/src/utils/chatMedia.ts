const CHAT_IMAGE_MAX_DIMENSION = 1600
const CHAT_IMAGE_JPEG_QUALITY = 0.8

type DrawableImage = {
  width: number
  height: number
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void
  release: () => void
}

async function loadDrawableImage(file: File): Promise<DrawableImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
        release: () => bitmap.close()
      }
    } catch {
      // Safari/WebView viejos caen al loader HTML de abajo.
    }
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = objectUrl
  await image.decode()

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
    release: () => URL.revokeObjectURL(objectUrl)
  }
}

function jpegFilename(filename = '') {
  const clean = filename.trim() || `foto-${Date.now()}`
  return `${clean.replace(/\.[a-z0-9]{2,8}$/i, '') || `foto-${Date.now()}`}.jpg`
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.size) resolve(blob)
      else reject(new Error('No se pudo optimizar la foto.'))
    }, 'image/jpeg', CHAT_IMAGE_JPEG_QUALITY)
  })
}

/**
 * Reduce una foto antes de convertirla a data URL. El backend mantiene la misma
 * compresión como red de seguridad, pero hacerla aquí evita subir megapíxeles
 * completos inflados en base64 desde web/PWA.
 */
export async function optimizeChatImageFile(file: File): Promise<File> {
  const mimeType = String(file.type || '').toLowerCase()
  if (!mimeType.startsWith('image/') || mimeType === 'image/gif' || mimeType === 'image/svg+xml') {
    return file
  }

  let drawable: DrawableImage | null = null
  try {
    drawable = await loadDrawableImage(file)
    const longestSide = Math.max(drawable.width, drawable.height)
    if (!longestSide) return file

    const ratio = Math.min(1, CHAT_IMAGE_MAX_DIMENSION / longestSide)
    const width = Math.max(1, Math.round(drawable.width * ratio))
    const height = Math.max(1, Math.round(drawable.height * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return file

    context.fillStyle = 'white'
    context.fillRect(0, 0, width, height)
    drawable.draw(context, width, height)
    const blob = await canvasToJpeg(canvas)

    if (ratio === 1 && blob.size >= file.size) return file
    return new File([blob], jpegFilename(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified || Date.now()
    })
  } catch {
    // La optimización es best-effort; el backend sigue validando y comprimiendo.
    return file
  } finally {
    drawable?.release()
  }
}
