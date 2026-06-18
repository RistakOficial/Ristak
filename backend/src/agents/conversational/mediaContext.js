import fetch from 'node-fetch'
import { extname } from 'path'
import { logger } from '../../utils/logger.js'
import {
  extractMediaAssetIdFromUrl,
  getMediaAssetBuffer
} from '../../services/mediaStorageService.js'
import {
  getOpenAIApiKey,
  transcribeVoiceAudio
} from '../../services/aiAgentService.js'

const MAX_MEDIA_ITEMS_TO_HYDRATE = 6
const MAX_INLINE_MEDIA_BYTES = Number(process.env.CONVERSATIONAL_AGENT_INLINE_MEDIA_MAX_BYTES || 18 * 1024 * 1024)
const MAX_AUDIO_TRANSCRIPTION_BYTES = Number(process.env.CONVERSATIONAL_AGENT_AUDIO_TRANSCRIPTION_MAX_BYTES || 24 * 1024 * 1024)
const FETCH_TIMEOUT_MS = Number(process.env.CONVERSATIONAL_AGENT_MEDIA_FETCH_TIMEOUT_MS || 12_000)
const MAX_TEXT_FILE_CHARS = 18_000

const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|javascript|x-javascript|csv))/
const SUPPORTED_FILE_INPUT_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'json', 'html', 'xml', 'csv', 'tsv',
  'doc', 'docx', 'rtf', 'odt',
  'ppt', 'pptx',
  'xls', 'xlsx'
])

function cleanString(value = '') {
  return String(value || '').trim()
}

function normalizeMimeType(value = '') {
  return cleanString(value).split(';')[0].toLowerCase()
}

function extensionFromFilename(filename = '') {
  return extname(cleanString(filename)).replace(/^\./, '').toLowerCase()
}

function pickFilename(row = {}) {
  const explicit = cleanString(row.media_filename || row.mediaFilename)
  if (explicit) return explicit.slice(0, 180)

  const type = cleanString(row.message_type || row.messageType || 'archivo').toLowerCase()
  const mimeType = normalizeMimeType(row.media_mime_type || row.mediaMimeType)
  const extension = mimeType.includes('/') ? mimeType.split('/').pop().replace(/[^a-z0-9]+/g, '') : 'bin'
  return `whatsapp-${type || 'archivo'}.${extension || 'bin'}`
}

export function inferConversationalMediaKind(row = {}) {
  const messageType = cleanString(row.message_type || row.messageType).toLowerCase()
  const mimeType = normalizeMimeType(row.media_mime_type || row.mediaMimeType)
  const filename = pickFilename(row)
  const extension = extensionFromFilename(filename)

  if (messageType === 'voice' || messageType === 'audio' || mimeType.startsWith('audio/')) return 'audio'
  if (messageType === 'image' || messageType === 'sticker' || mimeType.startsWith('image/')) return 'image'
  if (messageType === 'video' || mimeType.startsWith('video/')) return 'video'
  if (messageType === 'document' || mimeType === 'application/pdf') return 'document'
  if (TEXT_MIME_PATTERN.test(mimeType) || ['txt', 'md', 'json', 'csv', 'tsv', 'html', 'xml'].includes(extension)) return 'text'
  if (mimeType || extension) return 'file'
  return 'unknown'
}

function mediaKindLabel(kind = 'unknown') {
  return {
    audio: 'audio',
    image: 'imagen',
    video: 'video',
    document: 'documento',
    text: 'archivo de texto',
    file: 'archivo',
    unknown: 'archivo'
  }[kind] || 'archivo'
}

function hasMedia(row = {}) {
  return Boolean(cleanString(row.media_url || row.mediaUrl))
}

export function buildConversationalMediaSummary(row = {}, extra = {}) {
  if (!hasMedia(row)) return ''

  const kind = inferConversationalMediaKind(row)
  const lines = [
    `Adjunto recibido: ${mediaKindLabel(kind)}`,
    `Nombre: ${pickFilename(row)}`,
    normalizeMimeType(row.media_mime_type || row.mediaMimeType) ? `Tipo MIME: ${normalizeMimeType(row.media_mime_type || row.mediaMimeType)}` : '',
    row.media_duration_ms || row.mediaDurationMs ? `Duración: ${Math.round(Number(row.media_duration_ms || row.mediaDurationMs) / 1000)}s` : '',
    cleanString(row.media_url || row.mediaUrl) ? `URL: ${cleanString(row.media_url || row.mediaUrl)}` : ''
  ].filter(Boolean)

  if (extra.transcript) {
    lines.push(`Transcripción del audio: ${extra.transcript}`)
  }
  if (extra.readableText) {
    lines.push(`Texto extraído del archivo: ${extra.readableText}`)
  }
  if (extra.limitation) {
    lines.push(`Límite de lectura: ${extra.limitation}`)
  }

  return lines.join('\n')
}

function appendContextToContent(content = '', mediaContext = '') {
  const base = cleanString(content)
  const context = cleanString(mediaContext)
  if (!context) return base
  return [base, `[Contexto del adjunto para responder]\n${context}`].filter(Boolean).join('\n\n')
}

function bufferToDataUrl(buffer, mimeType = 'application/octet-stream') {
  return `data:${normalizeMimeType(mimeType) || 'application/octet-stream'};base64,${buffer.toString('base64')}`
}

function isTextFile(mimeType = '', filename = '') {
  const normalized = normalizeMimeType(mimeType)
  const extension = extensionFromFilename(filename)
  return TEXT_MIME_PATTERN.test(normalized) || ['txt', 'md', 'json', 'csv', 'tsv', 'html', 'xml'].includes(extension)
}

function isSupportedFileInput(mimeType = '', filename = '') {
  const normalized = normalizeMimeType(mimeType)
  const extension = extensionFromFilename(filename)
  return normalized === 'application/pdf' || SUPPORTED_FILE_INPUT_EXTENSIONS.has(extension)
}

function inferAttachmentKind(kind, mimeType = '', filename = '') {
  if (kind === 'image') return 'image'
  if (normalizeMimeType(mimeType) === 'application/pdf' || extensionFromFilename(filename) === 'pdf') return 'pdf'
  if (kind === 'text') return 'text'
  return 'file'
}

async function fetchExternalMediaBuffer(url, { maxBytes = MAX_INLINE_MEDIA_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > maxBytes) {
      throw new Error(`archivo demasiado grande (${contentLength} bytes)`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new Error(`archivo demasiado grande (${buffer.length} bytes)`)
    }

    return {
      buffer,
      mimeType: normalizeMimeType(response.headers.get('content-type')) || '',
      filename: ''
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readMediaBuffer(row = {}, { maxBytes = MAX_INLINE_MEDIA_BYTES, fetchMediaBuffer = null } = {}) {
  const mediaUrl = cleanString(row.media_url || row.mediaUrl)
  if (!mediaUrl) return null

  if (typeof fetchMediaBuffer === 'function') {
    return fetchMediaBuffer({ row, mediaUrl, maxBytes })
  }

  const assetId = extractMediaAssetIdFromUrl(mediaUrl)
  if (assetId) {
    const media = await getMediaAssetBuffer(assetId)
    if (media.buffer.length > maxBytes) {
      throw new Error(`archivo demasiado grande (${media.buffer.length} bytes)`)
    }
    return media
  }

  if (/^https?:\/\//i.test(mediaUrl)) {
    return fetchExternalMediaBuffer(mediaUrl, { maxBytes })
  }

  return null
}

async function resolveAudioTranscriptionApiKey({ aiProvider = 'openai', apiKey = '', audioTranscriptionApiKey = '' } = {}) {
  if (audioTranscriptionApiKey) return audioTranscriptionApiKey
  if (aiProvider === 'openai' && apiKey) return apiKey
  return getOpenAIApiKey().catch(() => null)
}

async function buildAudioContext(row, options = {}) {
  const apiKey = await resolveAudioTranscriptionApiKey(options)
  if (!apiKey) {
    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'No hay llave de OpenAI disponible para transcribir este audio. No digas que lo escuchaste; pide una descripción breve o manda a humano si es importante.'
      }),
      attachments: []
    }
  }

  try {
    const media = await readMediaBuffer(row, {
      maxBytes: MAX_AUDIO_TRANSCRIPTION_BYTES,
      fetchMediaBuffer: options.fetchMediaBuffer
    })
    if (!media?.buffer?.length) {
      throw new Error('audio no descargable')
    }

    const result = await (options.transcribeAudio || transcribeVoiceAudio)({
      apiKey,
      audioBuffer: media.buffer,
      mimeType: media.mimeType || row.media_mime_type || row.mediaMimeType || 'audio/webm'
    })

    return {
      context: buildConversationalMediaSummary(row, { transcript: cleanString(result?.text).slice(0, 12_000) }),
      attachments: []
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo transcribir audio adjunto: ${error.message}`)
    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'No se pudo transcribir este audio automáticamente. No digas que lo escuchaste; pide que lo escriba o manda a humano si bloquea la conversación.'
      }),
      attachments: []
    }
  }
}

async function buildBinaryContext(row, options = {}) {
  const kind = inferConversationalMediaKind(row)
  const includeBinary = options.includeBinary !== false
  const filename = pickFilename(row)
  const declaredMimeType = normalizeMimeType(row.media_mime_type || row.mediaMimeType)

  if (kind === 'video') {
    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'El agente recibe la referencia del video, pero no analiza movimiento ni audio del video completo en esta ruta. No afirmes haberlo visto completo si no hay descripción o transcripción.'
      }),
      attachments: []
    }
  }

  if (!includeBinary) {
    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'El proveedor de IA actual no tiene entrada multimedia binaria habilitada en Ristak. Usa sólo el texto, nombre y URL del adjunto.'
      }),
      attachments: []
    }
  }

  try {
    const media = await readMediaBuffer(row, {
      maxBytes: MAX_INLINE_MEDIA_BYTES,
      fetchMediaBuffer: options.fetchMediaBuffer
    })
    if (!media?.buffer?.length) {
      throw new Error('archivo no descargable')
    }

    const mimeType = normalizeMimeType(media.mimeType || declaredMimeType || 'application/octet-stream')
    const finalFilename = cleanString(media.filename) || filename

    if (isTextFile(mimeType, finalFilename)) {
      const text = media.buffer.toString('utf8').slice(0, MAX_TEXT_FILE_CHARS)
      return {
        context: buildConversationalMediaSummary(row, { readableText: text }),
        attachments: [{ kind: 'text', name: finalFilename, mimeType, text }]
      }
    }

    if (kind === 'image' || isSupportedFileInput(mimeType, finalFilename)) {
      return {
        context: buildConversationalMediaSummary(row),
        attachments: [{
          kind: inferAttachmentKind(kind, mimeType, finalFilename),
          name: finalFilename,
          mimeType,
          dataUrl: bufferToDataUrl(media.buffer, mimeType)
        }]
      }
    }

    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'Tipo de archivo no compatible para lectura directa por el modelo. Usa sólo texto, nombre y URL del adjunto.'
      }),
      attachments: []
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo preparar adjunto multimedia: ${error.message}`)
    return {
      context: buildConversationalMediaSummary(row, {
        limitation: 'No se pudo descargar o preparar este adjunto. No afirmes haberlo visto; pide una descripción breve o manda a humano si es necesario.'
      }),
      attachments: []
    }
  }
}

export async function hydrateConversationalMessagesMedia(messages = [], options = {}) {
  const input = Array.isArray(messages) ? messages : []
  const hydrateIndexes = []

  for (let index = input.length - 1; index >= 0 && hydrateIndexes.length < MAX_MEDIA_ITEMS_TO_HYDRATE; index -= 1) {
    const message = input[index]
    if (message?.role !== 'user' || !hasMedia(message)) continue
    hydrateIndexes.push(index)
  }
  const hydrateSet = new Set(hydrateIndexes)
  const output = []

  for (let index = 0; index < input.length; index += 1) {
    const message = input[index]
    if (message?.role !== 'user' || !hasMedia(message)) {
      output.push(message)
      continue
    }

    const kind = inferConversationalMediaKind(message)
    const hydrated = hydrateSet.has(index)
      ? (kind === 'audio'
        ? await buildAudioContext(message, options)
        : await buildBinaryContext(message, options))
      : {
          context: buildConversationalMediaSummary(message, {
            limitation: 'Adjunto antiguo resumido sólo como referencia para ahorrar contexto.'
          }),
          attachments: []
        }

    output.push({
      ...message,
      content: appendContextToContent(message.content, hydrated.context),
      attachments: [
        ...(Array.isArray(message.attachments) ? message.attachments : []),
        ...hydrated.attachments
      ]
    })
  }

  return output
}
