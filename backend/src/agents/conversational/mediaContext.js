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
const MAX_PREVIEW_ATTACHMENT_BYTES = Number(process.env.CONVERSATIONAL_AGENT_PREVIEW_MEDIA_MAX_BYTES || MAX_INLINE_MEDIA_BYTES)
const FETCH_TIMEOUT_MS = Number(process.env.CONVERSATIONAL_AGENT_MEDIA_FETCH_TIMEOUT_MS || 12_000)
const VISUAL_ANALYSIS_TIMEOUT_MS = Number(process.env.CONVERSATIONAL_AGENT_VISUAL_ANALYSIS_TIMEOUT_MS || 20_000)
const VISUAL_ANALYSIS_MODEL = process.env.CONVERSATIONAL_AGENT_VISUAL_ANALYSIS_MODEL || process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || 'gpt-5.4-nano'
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const MAX_TEXT_FILE_CHARS = 18_000
const MAX_ATTACHMENT_ANALYSIS_CHARS = 2_400

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
  return `chat-${type || 'archivo'}.${extension || 'bin'}`
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

function binaryMediaGuidance(kind = 'file') {
  if (kind === 'video') {
    return 'Lectura del adjunto: se adjunto una miniatura visual del video para analizar lo visible en ese cuadro. No afirmes movimiento ni audio completo sin transcripcion.'
  }
  if (kind === 'image') {
    return 'Lectura del adjunto: la imagen fue adjuntada al modelo para analisis directo. Usala para responder; no digas que no puedes verla salvo que el adjunto no este disponible.'
  }
  return 'Lectura del adjunto: el archivo fue adjuntado al modelo para analisis directo. Usalo para responder; no digas que no puedes verlo salvo que el adjunto no este disponible.'
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
  if (extra.analysis) {
    lines.push(`Analisis automatico del adjunto: ${extra.analysis}`)
  }
  if (extra.binaryAttached) {
    lines.push(extra.binaryAttached)
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

function isDataUrl(value = '') {
  return /^data:[^,]*;base64,/i.test(cleanString(value))
}

function mimeTypeFromDataUrl(dataUrl = '') {
  const match = cleanString(dataUrl).match(/^data:([^;,]+)(?:;[^,]*)*;base64,/i)
  return normalizeMimeType(match?.[1] || '')
}

function dataUrlToBuffer(dataUrl = '', maxBytes = MAX_PREVIEW_ATTACHMENT_BYTES) {
  const text = cleanString(dataUrl)
  const match = text.match(/^data:([^;,]+)?(?:;[^,]*)*;base64,([\s\S]*)$/i)
  if (!match) return null

  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > maxBytes) {
    throw new Error(`archivo demasiado grande (${buffer.length} bytes)`)
  }

  return {
    buffer,
    mimeType: normalizeMimeType(match[1] || '')
  }
}

function extractOpenAIResponseText(payload = {}) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return cleanString(payload.output_text)
  }

  const chunks = []
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim())
      }
    }
  }

  return cleanString(chunks.join('\n'))
}

async function resolveVisualAnalysisApiKey(options = {}) {
  const explicit = cleanString(options.visualAnalysisApiKey)
  if (explicit) return explicit
  if (options.aiProvider === 'openai' && cleanString(options.apiKey)) return cleanString(options.apiKey)
  return getOpenAIApiKey().catch(() => null)
}

function buildAttachmentAnalysisPart(attachment = {}) {
  if (attachment.kind === 'video' && isDataUrl(attachment.thumbnailDataUrl)) {
    return {
      type: 'input_image',
      image_url: attachment.thumbnailDataUrl,
      detail: 'auto'
    }
  }

  if (attachment.kind === 'image' && isDataUrl(attachment.dataUrl)) {
    return {
      type: 'input_image',
      image_url: attachment.dataUrl,
      detail: 'auto'
    }
  }

  if (isSupportedFileInput(attachment.mimeType, attachment.name) && isDataUrl(attachment.dataUrl)) {
    return {
      type: 'input_file',
      filename: attachment.name || 'archivo',
      file_data: attachment.dataUrl
    }
  }

  return null
}

async function analyzeAttachmentAsText(attachment = {}, options = {}) {
  const analysisPart = buildAttachmentAnalysisPart(attachment)
  if (!analysisPart) return ''

  if (typeof options.analyzeVisualMedia === 'function') {
    try {
      const result = await options.analyzeVisualMedia({ attachment, analysisPart })
      return cleanString(typeof result === 'string' ? result : result?.text).slice(0, MAX_ATTACHMENT_ANALYSIS_CHARS)
    } catch (error) {
      logger.warn(`[Agente conversacional] Lector auxiliar de adjunto fallo: ${error.message}`)
      return ''
    }
  }

  const apiKey = await resolveVisualAnalysisApiKey(options)
  if (!apiKey) return ''

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VISUAL_ANALYSIS_TIMEOUT_MS)
  try {
    const kind = attachment.kind === 'video' ? 'miniatura de video' : mediaKindLabel(attachment.kind)
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: VISUAL_ANALYSIS_MODEL,
        max_output_tokens: 450,
        instructions: 'Eres un lector auxiliar de adjuntos para un canal conversacional. Describe solo lo visible o legible, en espanol natural, breve y util para que otro agente pueda responder. No inventes datos fuera del adjunto.',
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Analiza este adjunto (${kind}). Nombre: ${attachment.name || 'archivo'}. Tipo MIME: ${attachment.mimeType || 'desconocido'}.`
            },
            analysisPart
          ]
        }]
      })
    })

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`
      throw new Error(message)
    }

    return extractOpenAIResponseText(payload).slice(0, MAX_ATTACHMENT_ANALYSIS_CHARS)
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo analizar adjunto con lector auxiliar: ${error.message}`)
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

function inferPreviewAttachmentKind(attachment = {}) {
  const explicit = cleanString(attachment.kind || attachment.type).toLowerCase()
  const mimeType = normalizeMimeType(attachment.mimeType || attachment.type || mimeTypeFromDataUrl(attachment.dataUrl))
  const filename = cleanString(attachment.name || attachment.filename || attachment.fileName)
  const extension = extensionFromFilename(filename)

  if (explicit === 'audio' || mimeType.startsWith('audio/')) return 'audio'
  if (explicit === 'image' || mimeType.startsWith('image/')) return 'image'
  if (explicit === 'video' || mimeType.startsWith('video/')) return 'video'
  if (explicit === 'document' || explicit === 'pdf' || mimeType === 'application/pdf') return 'document'
  if (explicit === 'text' || isTextFile(mimeType, filename)) return 'text'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt'].includes(extension)) return 'document'
  return 'file'
}

function sanitizePreviewAttachment(attachment = {}) {
  const dataUrl = isDataUrl(attachment.dataUrl) ? cleanString(attachment.dataUrl) : ''
  const thumbnailDataUrl = isDataUrl(attachment.thumbnailDataUrl) ? cleanString(attachment.thumbnailDataUrl) : ''
  const inferredMimeType = normalizeMimeType(attachment.mimeType || attachment.type || mimeTypeFromDataUrl(dataUrl) || mimeTypeFromDataUrl(thumbnailDataUrl))
  const kind = inferPreviewAttachmentKind({ ...attachment, mimeType: inferredMimeType })
  const name = cleanString(attachment.name || attachment.filename || attachment.fileName) ||
    `demo-${mediaKindLabel(kind)}.${inferredMimeType.includes('/') ? inferredMimeType.split('/').pop().replace(/[^a-z0-9]+/g, '') : 'bin'}`
  const durationMs = Number(attachment.durationMs || attachment.duration_ms || 0) || 0
  const size = Number(attachment.size || 0) || 0

  return {
    kind,
    name: name.slice(0, 180),
    mimeType: inferredMimeType || 'application/octet-stream',
    dataUrl,
    thumbnailDataUrl,
    text: cleanString(attachment.text).slice(0, MAX_TEXT_FILE_CHARS),
    durationMs,
    size
  }
}

function previewAttachmentSummary(attachment = {}, extra = {}) {
  const kind = attachment.kind || inferPreviewAttachmentKind(attachment)
  const lines = [
    `Adjunto recibido: ${mediaKindLabel(kind)}`,
    `Nombre: ${attachment.name || 'archivo'}`,
    attachment.mimeType ? `Tipo MIME: ${attachment.mimeType}` : '',
    attachment.size ? `Tamaño: ${Math.round(Number(attachment.size) / 1024)} KB` : '',
    attachment.durationMs ? `Duración: ${Math.round(Number(attachment.durationMs) / 1000)}s` : ''
  ].filter(Boolean)

  if (extra.transcript) {
    lines.push(`Transcripción del audio: ${extra.transcript}`)
  }
  if (extra.readableText) {
    lines.push(`Texto extraído del archivo: ${extra.readableText}`)
  }
  if (extra.analysis) {
    lines.push(`Analisis automatico del adjunto: ${extra.analysis}`)
  }
  if (extra.binaryAttached) {
    lines.push(extra.binaryAttached)
  }
  if (extra.limitation) {
    lines.push(`Límite de lectura: ${extra.limitation}`)
  }

  return lines.join('\n')
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

async function buildTextualAnalysisContext(row, options = {}) {
  const kind = inferConversationalMediaKind(row)
  const filename = pickFilename(row)
  const declaredMimeType = normalizeMimeType(row.media_mime_type || row.mediaMimeType)

  if (kind === 'video') return null

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
      const analysis = await analyzeAttachmentAsText({
        kind: inferAttachmentKind(kind, mimeType, finalFilename),
        name: finalFilename,
        mimeType,
        dataUrl: bufferToDataUrl(media.buffer, mimeType)
      }, options)

      if (analysis) {
        return {
          context: buildConversationalMediaSummary(row, { analysis }),
          attachments: []
        }
      }
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo preparar lectura textual del adjunto: ${error.message}`)
  }

  return null
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
    const analyzed = await buildTextualAnalysisContext(row, options)
    if (analyzed) return analyzed

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
        context: buildConversationalMediaSummary(row, { binaryAttached: binaryMediaGuidance(kind) }),
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

async function preparePreviewAttachment(attachment = {}, options = {}) {
  const item = sanitizePreviewAttachment(attachment)
  const includeBinary = options.includeBinary !== false

  if (item.kind === 'audio') {
    const apiKey = await resolveAudioTranscriptionApiKey(options)
    if (!apiKey) {
      return {
        context: previewAttachmentSummary(item, {
          limitation: 'No hay llave de OpenAI disponible para transcribir este audio. No digas que lo escuchaste; pide una descripción breve o manda a humano si es importante.'
        }),
        attachment: null
      }
    }

    try {
      const media = dataUrlToBuffer(item.dataUrl, MAX_AUDIO_TRANSCRIPTION_BYTES)
      if (!media?.buffer?.length) throw new Error('audio no legible')
      const result = await (options.transcribeAudio || transcribeVoiceAudio)({
        apiKey,
        audioBuffer: media.buffer,
        mimeType: media.mimeType || item.mimeType || 'audio/webm'
      })
      return {
        context: previewAttachmentSummary(item, { transcript: cleanString(result?.text).slice(0, 12_000) }),
        attachment: null
      }
    } catch (error) {
      logger.warn(`[Agente conversacional] No se pudo transcribir audio del demo: ${error.message}`)
      return {
        context: previewAttachmentSummary(item, {
          limitation: 'No se pudo transcribir este audio automáticamente. No digas que lo escuchaste; pide que lo escriba o manda a humano si bloquea la conversación.'
        }),
        attachment: null
      }
    }
  }

  if (item.kind === 'video') {
    const hasThumbnail = Boolean(item.thumbnailDataUrl && includeBinary)
    const analysis = hasThumbnail ? '' : await analyzeAttachmentAsText(item, options)
    return {
      context: previewAttachmentSummary(item, hasThumbnail
        ? { binaryAttached: binaryMediaGuidance('video') }
        : analysis
          ? {
              analysis,
              limitation: 'El analisis se baso en una miniatura visual del video; no afirmes movimiento ni audio completo sin transcripcion.'
            }
          : {
            limitation: 'El agente recibe la referencia del video, pero no analiza movimiento ni audio del video completo en esta ruta. No afirmes haberlo visto completo si no hay descripción o transcripción.'
          }),
      attachment: hasThumbnail
        ? {
            kind: 'video',
            name: item.name,
            mimeType: item.mimeType,
            thumbnailDataUrl: item.thumbnailDataUrl
          }
        : null
    }
  }

  if (item.text || item.kind === 'text' || isTextFile(item.mimeType, item.name)) {
    let readableText = item.text
    if (!readableText && item.dataUrl) {
      try {
        const media = dataUrlToBuffer(item.dataUrl, MAX_PREVIEW_ATTACHMENT_BYTES)
        readableText = media?.buffer?.toString('utf8').slice(0, MAX_TEXT_FILE_CHARS) || ''
      } catch (error) {
        logger.warn(`[Agente conversacional] No se pudo leer texto del demo: ${error.message}`)
      }
    }

    return {
      context: previewAttachmentSummary(item, readableText
        ? { readableText }
        : { limitation: 'El archivo de texto llegó sin contenido legible. Pide que lo reenvíen o que peguen el texto.' }),
      attachment: readableText
        ? { kind: 'text', name: item.name, mimeType: item.mimeType, text: readableText }
        : null
    }
  }

  if (!includeBinary) {
    const analysis = await analyzeAttachmentAsText(item, options)
    return {
      context: previewAttachmentSummary(item, analysis
        ? { analysis }
        : {
            limitation: 'El proveedor de IA actual no tiene entrada multimedia binaria habilitada en Ristak. Usa sólo el texto y datos del adjunto.'
          }),
      attachment: null
    }
  }

  try {
    if (item.dataUrl) {
      dataUrlToBuffer(item.dataUrl, MAX_PREVIEW_ATTACHMENT_BYTES)
    }
    if (item.kind === 'image' || isSupportedFileInput(item.mimeType, item.name)) {
      return {
        context: previewAttachmentSummary(item, { binaryAttached: binaryMediaGuidance(item.kind) }),
        attachment: {
          kind: inferAttachmentKind(item.kind, item.mimeType, item.name),
          name: item.name,
          mimeType: item.mimeType,
          dataUrl: item.dataUrl
        }
      }
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo preparar adjunto del demo: ${error.message}`)
    return {
      context: previewAttachmentSummary(item, {
        limitation: 'No se pudo preparar este adjunto. No afirmes haberlo visto; pide una descripción breve o manda a humano si hace falta.'
      }),
      attachment: null
    }
  }

  return {
    context: previewAttachmentSummary(item, {
      limitation: 'Tipo de archivo no compatible para lectura directa por el modelo. Usa sólo nombre, tipo y cualquier texto escrito por el usuario.'
    }),
    attachment: null
  }
}

export async function hydrateConversationalPreviewMessagesMedia(messages = [], options = {}) {
  const input = Array.isArray(messages) ? messages : []
  const output = []

  for (const message of input) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments.slice(0, MAX_MEDIA_ITEMS_TO_HYDRATE) : []
    if (message?.role !== 'user' || !attachments.length) {
      output.push(message)
      continue
    }

    const contexts = []
    const preparedAttachments = []
    for (const attachment of attachments) {
      const prepared = await preparePreviewAttachment(attachment, options)
      if (prepared.context) contexts.push(prepared.context)
      if (prepared.attachment) preparedAttachments.push(prepared.attachment)
    }

    output.push({
      ...message,
      content: appendContextToContent(message.content, contexts.join('\n\n')),
      attachments: preparedAttachments
    })
  }

  return output
}
