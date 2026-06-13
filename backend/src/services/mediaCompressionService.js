import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '../utils/logger.js'

/**
 * Compresor universal de medios (estilo WhatsApp): todo archivo que sube el
 * usuario pasa por aquí y sale en el mejor formato calidad/peso sin que él
 * tenga que usar convertidores.
 *
 *  - Imágenes → WebP (máx. 1600px, calidad 80)
 *  - Audio    → Ogg Opus mono 48 kHz (el formato EXACTO de las notas de voz
 *               de WhatsApp: "audio/ogg; codecs=opus")
 *  - Video    → MP4 H.264 (máx. 1280px, CRF 27) + audio AAC, faststart
 *
 * Si ffmpeg no está disponible o algo falla, se guarda el original: la
 * compresión nunca debe bloquear una subida.
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

export const WHATSAPP_VOICE_NOTE_MIME = 'audio/ogg; codecs=opus'

function runFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args)
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('La conversión tardó demasiado'))
    }, timeoutMs)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().slice(0, 200) || `ffmpeg salió con código ${code}`))
    })
  })
}

async function withTempDir(fn) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-media-'))
  try {
    return await fn(folder)
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

function extensionOf(contentType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav'
  }
  return map[contentType.split(';')[0].trim()] || 'bin'
}

/**
 * Comprime el buffer según su tipo. Devuelve { buffer, contentType, note } —
 * si no conviene o falla, regresa el original sin tocar.
 */
export async function compressMediaBuffer({ buffer, contentType }) {
  const family = String(contentType || '').split('/')[0]
  const base = String(contentType || '').split(';')[0].trim()

  try {
    // GIF (animaciones) y SVG se quedan igual
    if (base === 'image/gif' || base === 'image/svg+xml') {
      return { buffer, contentType, note: 'original' }
    }

    if (family === 'image') {
      const compressed = await withTempDir(async (folder) => {
        const input = join(folder, `input.${extensionOf(base)}`)
        const output = join(folder, 'output.webp')
        await fs.writeFile(input, buffer)
        await runFfmpeg([
          '-y', '-i', input,
          '-vf', "scale='min(1600,iw)':-2",
          '-c:v', 'libwebp', '-quality', '80',
          output
        ], 60000)
        return fs.readFile(output)
      })
      // Solo se conserva si de verdad pesa menos
      if (compressed.length > 0 && compressed.length < buffer.length) {
        return { buffer: compressed, contentType: 'image/webp', note: 'webp' }
      }
      return { buffer, contentType, note: 'original' }
    }

    if (family === 'audio') {
      // Ya viene en el formato de nota de voz de WhatsApp
      if (base === 'audio/ogg' && String(contentType).toLowerCase().includes('opus')) {
        return { buffer, contentType: WHATSAPP_VOICE_NOTE_MIME, note: 'original' }
      }
      const compressed = await withTempDir(async (folder) => {
        const input = join(folder, `input.${extensionOf(base)}`)
        const output = join(folder, 'voice.ogg')
        await fs.writeFile(input, buffer)
        await runFfmpeg([
          '-y', '-i', input,
          '-vn', '-ac', '1', '-ar', '48000',
          '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
          output
        ], 90000)
        return fs.readFile(output)
      })
      if (compressed.length > 0) {
        // Siempre se guarda en Ogg Opus: es lo que WhatsApp exige para voz
        return { buffer: compressed, contentType: WHATSAPP_VOICE_NOTE_MIME, note: 'opus' }
      }
      return { buffer, contentType, note: 'original' }
    }

    if (family === 'video') {
      const compressed = await withTempDir(async (folder) => {
        const input = join(folder, `input.${extensionOf(base)}`)
        const output = join(folder, 'output.mp4')
        await fs.writeFile(input, buffer)
        await runFfmpeg([
          '-y', '-i', input,
          '-vf', "scale='min(1280,iw)':-2",
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
          '-c:a', 'aac', '-b:a', '96k',
          '-movflags', '+faststart',
          output
        ], 240000)
        return fs.readFile(output)
      })
      if (compressed.length > 0 && compressed.length < buffer.length) {
        return { buffer: compressed, contentType: 'video/mp4', note: 'mp4' }
      }
      return { buffer, contentType, note: 'original' }
    }
  } catch (error) {
    logger.warn(`[Medios] No se pudo comprimir (${contentType}): ${error.message} — se guarda el original`)
  }

  return { buffer, contentType, note: 'original' }
}
