import { promises as fs } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import JSZip from 'jszip'
import {
  cancelBunnyStreamResumableUpload,
  createMediaFolder,
  deleteMediaSelection,
  extractMediaAssetIdFromUrl,
  finalizeBunnyStreamResumableUpload,
  getMediaAsset,
  getMediaAssetBunnyStreamAnalytics,
  getMediaAssetBuffer,
  getMediaAssetFile,
  getMediaAssetReadStream,
  getStorageUsage,
  listMediaAssets,
  listMediaFolders,
  moveMediaAssets,
  moveMediaSelection,
  prepareBunnyStreamResumableUpload,
  replaceMediaAsset,
  retryMediaAsset,
  resolveMediaAssetSelection,
  runStorageDiagnostics,
  softDeleteMediaAsset,
  syncMediaAssetBunnyStream,
  uploadMediaAsset,
  uploadMediaAssetFromDataUrl
} from '../services/mediaStorageService.js'
import { logger } from '../utils/logger.js'
import { db } from '../config/database.js'
import {
  isValidWhatsAppVoiceNoteBuffer,
  prepareWhatsAppMediaForDirectUpload
} from '../services/whatsappApiService.js'
import {
  createMediaUploadRequestHashes,
  runIdempotentMediaUpload
} from '../services/mediaUploadSafetyService.js'
import { attachmentDisposition, safeHeaderFilename } from '../utils/contentDisposition.js'

const MAX_ARCHIVE_DOWNLOAD_ITEMS = Number(process.env.MEDIA_MAX_ARCHIVE_DOWNLOAD_ITEMS || 500)
const MAX_ARCHIVE_DOWNLOAD_BYTES = 512 * 1024 * 1024

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return /^(1|true|yes|si|on)$/i.test(String(value).trim())
}

function sendError(res, error, fallback = 'Error procesando almacenamiento multimedia') {
  const status = error.status || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback,
    ...(error.code ? { code: error.code } : {}),
    ...(error.details ? { details: error.details } : {})
  })
}

function voiceNoteTransportFilename(assetId = '') {
  // Esta ruta la consume Meta, no es una descarga con el nombre original.
  // Si el usuario subió un MP3 que después convertimos a OGG/Opus, conservar
  // `.mp3` en Content-Disposition contradice el MIME y Meta reclasifica los
  // bytes como application/octet-stream (131053).
  const safeAssetId = cleanString(assetId).replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'audio'
  return `ristak-voice-${safeAssetId}.ogg`
}

function ensureZipFilename(value = '') {
  const filename = safeHeaderFilename(value, 'media.zip')
  return /\.zip$/i.test(filename) ? filename : `${filename}.zip`
}

function sanitizeZipSegment(value = '') {
  const segment = String(value || '')
    .trim()
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '-')
    .replace(/\.+$/g, '')
    .slice(0, 160)
  if (!segment || segment === '.' || segment === '..') return ''
  return segment
}

function sanitizeZipPath(value = '', fallback = 'archivo') {
  const parts = String(value || fallback)
    .split(/[\\/]+/)
    .map(sanitizeZipSegment)
    .filter(Boolean)

  if (!parts.length) {
    parts.push(sanitizeZipSegment(fallback) || 'archivo')
  }

  return parts.join('/')
}

function uniqueZipPath(path, usedPaths) {
  let candidate = path
  let index = 2
  while (usedPaths.has(candidate)) {
    const slashIndex = path.lastIndexOf('/')
    const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : ''
    const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path
    const dotIndex = filename.lastIndexOf('.')
    const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename
    const extension = dotIndex > 0 ? filename.slice(dotIndex) : ''
    candidate = `${directory}${base} (${index})${extension}`
    index += 1
  }
  usedPaths.add(candidate)
  return candidate
}

function archiveEntriesFromBody(body = {}) {
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : Array.isArray(body.assetIds)
      ? body.assetIds.map((id) => ({ id }))
      : []
  const seen = new Set()
  const entries = []

  for (const rawEntry of rawEntries) {
    const id = String(typeof rawEntry === 'string' ? rawEntry : rawEntry?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      path: typeof rawEntry === 'object' && rawEntry ? String(rawEntry.path || rawEntry.filename || '') : ''
    })
  }

  return entries
}

function downloadInputError(message, status = 400, code = 'invalid_media_download') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function validateMediaArchiveEntries(entries = []) {
  let totalBytes = 0
  for (const entry of entries) {
    const sizeBytes = Math.floor(Number(entry?.sizeBytes) || 0)
    if (sizeBytes <= 0) {
      throw downloadInputError(
        'Uno de los archivos no tiene un tamaño verificable. Vuelve a subirlo o descárgalo por separado.',
        409,
        'media_archive_size_unknown'
      )
    }
    totalBytes += sizeBytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_DOWNLOAD_BYTES) {
      throw downloadInputError(
        'El ZIP supera el límite seguro de 512 MB. Descarga la carpeta en lotes más pequeños.',
        413,
        'media_archive_bytes_too_large'
      )
    }
  }
  return totalBytes
}

function lazyBoundedArchiveStream(entry, budget) {
  return Readable.from((async function * readEntry() {
    const source = await getMediaAssetReadStream(entry.id)
    for await (const rawChunk of source.stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      budget.bytesRead += chunk.length
      if (budget.bytesRead > MAX_ARCHIVE_DOWNLOAD_BYTES) {
        throw downloadInputError(
          'El contenido real del ZIP superó el límite seguro de 512 MB.',
          413,
          'media_archive_bytes_too_large'
        )
      }
      yield chunk
    }
  })())
}

function cleanString(value = '') {
  return String(value || '').trim()
}

function mediaUploadRequestError(message, code = 'media_upload_module_mismatch') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

const TENANT_SCOPED_MEDIA_MODULES = new Set(['sites', 'forms', 'landing'])

export function directChatCompatibilityFromRequest(req = {}) {
  // Este contrato se resuelve ANTES de multer. El body multipart todavía no
  // existe en ese momento y jamás puede elevar después una subida normal a
  // Chat ni heredar el límite general de 600 MB.
  const module = cleanString(req.query?.module).toLowerCase()
  const compatibility = cleanString(
    req.query?.chatCompatibility || req.query?.chat_compatibility
  ).toLowerCase()
  const kind = cleanString(
    req.query?.chatMediaKind || req.query?.chat_media_kind
  ).toLowerCase()
  return {
    enabled: module === 'chat' && compatibility === 'whatsapp' &&
      ['image', 'video', 'audio', 'document'].includes(kind),
    kind
  }
}

export function trustedUploadContextFromRequest(req = {}) {
  const body = req.body || {}
  const directChat = req.directChatUpload || directChatCompatibilityFromRequest(req)
  if (!directChat.enabled) {
    const trustedModule = cleanString(req.mediaUploadModule || req.query?.module).toLowerCase()
    const bodyModule = cleanString(body.module).toLowerCase()
    const hasFolderPath = Object.prototype.hasOwnProperty.call(body, 'folderPath') ||
      Object.prototype.hasOwnProperty.call(body, 'folder_path') ||
      Object.prototype.hasOwnProperty.call(body, 'path')
    if (trustedModule && trustedModule !== 'other' && bodyModule && bodyModule !== trustedModule) {
      throw mediaUploadRequestError('El módulo de la subida no coincide con la superficie autorizada.')
    }
    const tenantScoped = TENANT_SCOPED_MEDIA_MODULES.has(trustedModule || bodyModule) && req.user?.role !== 'admin'
    // Un empleado de Sites no puede fabricar otra cuota, cuenta o identidad.
    // Los admins conservan el contrato multi-cuenta de la biblioteca legacy.
    // Si el módulo llegó en query, ése es autoritativo: el gate corre antes de
    // que Multer pueda leer el body multipart.
    return {
      businessId: tenantScoped
        ? cleanString(process.env.RISTAK_BUSINESS_ID) || 'default'
        : body.businessId || body.business_id || req.query?.businessId || 'default',
      clientAccountId: tenantScoped
        ? null
        : body.clientAccountId || body.client_account_id ||
          body.accountId || body.account_id || body.locationId || body.location_id ||
          req.query?.clientAccountId || req.query?.client_account_id ||
          req.query?.accountId || req.query?.account_id ||
          req.query?.locationId || req.query?.location_id || null,
      userId: tenantScoped
        ? req.user?.userId || req.user?.id || null
        : body.userId || body.user_id || req.user?.userId || req.user?.id || null,
      module: trustedModule && trustedModule !== 'other' ? trustedModule : body.module || 'other',
      moduleEntityId: body.moduleEntityId || body.module_entity_id || null,
      // Sólo la biblioteca administrativa puede elegir una ruta exacta. Los
      // demás módulos conservan su taxonomía automática y nunca aceptan una
      // carpeta enviada por el navegador.
      folderPath: trustedModule === 'media' && hasFolderPath
        ? body.folderPath ?? body.folder_path ?? body.path ?? ''
        : null,
      isPublic: parseBoolean(body.isPublic ?? body.is_public, true),
      deferStreamSync: parseBoolean(
        body.deferStreamSync ?? body.defer_stream_sync ??
        req.query?.deferStreamSync ?? req.query?.defer_stream_sync,
        true
      ),
      clientUploadId: body.clientUploadId || body.client_upload_id ||
        body.uploadSessionId || body.upload_session_id ||
        req.get?.('x-ristak-upload-id') || null
    }
  }

  return {
    // Una instalación corresponde a un tenant. El cliente no puede inventar
    // businessId/clientAccountId para abrir otra cuota o escribir en otra raíz.
    businessId: cleanString(process.env.RISTAK_BUSINESS_ID) || 'default',
    clientAccountId: null,
    userId: req.user?.userId || req.user?.id || null,
    module: 'chat',
    moduleEntityId: body.moduleEntityId || body.module_entity_id || null,
    folderPath: null,
    isPublic: parseBoolean(body.isPublic ?? body.is_public, true),
    deferStreamSync: parseBoolean(
      body.deferStreamSync ?? body.defer_stream_sync ??
      req.query?.deferStreamSync ?? req.query?.defer_stream_sync,
      true
    ),
    clientUploadId: body.clientUploadId || body.client_upload_id ||
      body.uploadSessionId || body.upload_session_id ||
      req.get?.('x-ristak-upload-id') || null
  }
}

export async function prepareResumableVideoUploadHandler(req, res) {
  try {
    const context = trustedUploadContextFromRequest(req)
    const prepared = await prepareBunnyStreamResumableUpload({
      ...context,
      filename: req.body?.filename || req.body?.fileName || req.body?.originalFilename,
      mimeType: req.body?.mimeType || req.body?.contentType,
      size: req.body?.size,
      lastModified: req.body?.lastModified,
      clientUploadId: req.body?.clientUploadId || req.body?.client_upload_id
    })
    res.status(prepared.completed ? 200 : 201).json({ success: true, data: prepared })
  } catch (error) {
    logger.error(`[MediaStorage] Error preparando video resumible: ${error.message}`)
    sendError(res, error, 'No se pudo preparar la subida resumible')
  }
}

export async function finalizeResumableVideoUploadHandler(req, res) {
  try {
    const context = trustedUploadContextFromRequest(req)
    const asset = await finalizeBunnyStreamResumableUpload(req.params.assetId, {
      ...context,
      uploadUrl: req.body?.uploadUrl || req.body?.upload_url
    })
    res.json({ success: true, data: asset })
  } catch (error) {
    logger.error(`[MediaStorage] Error finalizando video resumible: ${error.message}`)
    sendError(res, error, 'No se pudo finalizar la subida resumible')
  }
}

export async function cancelResumableVideoUploadHandler(req, res) {
  try {
    const context = trustedUploadContextFromRequest(req)
    const result = await cancelBunnyStreamResumableUpload(req.params.assetId, context)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`[MediaStorage] Error cancelando video resumible: ${error.message}`)
    sendError(res, error, 'No se pudo cancelar la subida resumible')
  }
}

export function mediaUploadRequestDescriptor(
  req = {},
  context = {},
  directChat = {},
  { includeClientAccount = true } = {}
) {
  const descriptor = {
    businessId: context.businessId,
    userId: context.userId === null || context.userId === undefined
      ? null
      : String(context.userId),
    module: context.module,
    moduleEntityId: context.moduleEntityId,
    isPublic: context.isPublic,
    deferStreamSync: context.deferStreamSync,
    chatCompatibility: directChat.enabled ? 'whatsapp' : '',
    chatMediaKind: directChat.kind || '',
    filename: req.file?.originalname || req.body?.filename || req.body?.fileName || '',
    mimeType: req.file?.mimetype || '',
    size: req.file?.size || null
  }
  // Compatibilidad del ledger ya desplegado: las subidas de Chat no tenían
  // clientAccountId en su descriptor. Omitir la propiedad cuando no existe
  // conserva exactamente el SHA anterior; las rutas administrativas con cuenta
  // explícita sí la incorporan para impedir replays entre locations.
  if (includeClientAccount && cleanString(context.clientAccountId)) {
    descriptor.clientAccountId = cleanString(context.clientAccountId)
  }
  if (context.folderPath !== null && context.folderPath !== undefined) {
    descriptor.folderPath = cleanString(context.folderPath)
  }
  return descriptor
}

function normalizedUploadAccountId(value = '') {
  return cleanString(value)
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
}

function accountIdFromUploadResponse(response = {}) {
  return cleanString(
    response?.metadata?.clientAccount?.id ||
    response?.metadata?.client_account?.id
  )
}

async function compatibleReplayBelongsToAccount(response, row, expectedAccountId) {
  const expected = normalizedUploadAccountId(expectedAccountId)
  if (!expected) return false
  let actual = accountIdFromUploadResponse(response)
  if (!actual) {
    const assetId = cleanString(row?.asset_id || response?.id)
    const asset = assetId
      ? await db.get(
          `SELECT metadata_json
           FROM media_assets
           WHERE id = ? AND business_id = ?
           LIMIT 1`,
          [assetId, row?.business_id]
        ).catch(() => null)
      : null
    try {
      const metadata = asset?.metadata_json ? JSON.parse(asset.metadata_json) : {}
      actual = cleanString(metadata?.clientAccount?.id || metadata?.client_account?.id)
    } catch {
      actual = ''
    }
  }
  return normalizedUploadAccountId(actual) === expected
}

export async function uploadInputFromRequest(req) {
  const body = req.body || {}
  const common = trustedUploadContextFromRequest(req)

  if (req.file?.path) {
    const chatCompatibility = directChatCompatibilityFromRequest(req)
    if (chatCompatibility.enabled) {
      const buffer = await fs.readFile(req.file.path)
      const prepared = await prepareWhatsAppMediaForDirectUpload({
        buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
        kind: chatCompatibility.kind
      })
      return {
        mode: 'buffer',
        input: {
          ...common,
          buffer: prepared.buffer,
          filename: prepared.filename,
          mimeType: prepared.mimeType,
          skipCompression: true,
          metadata: {
            ...(prepared.metadata || {}),
            source: 'ios_direct_chat_upload'
          }
        }
      }
    }

    // No leemos el archivo a memoria: pasamos la ruta temporal en disco para que
    // el servicio transmita los archivos grandes/videos directo a Bunny (sin OOM).
    // El servicio se encarga de borrar el temporal al terminar.
    return {
      mode: 'buffer',
      input: {
        ...common,
        filePath: req.file.path,
        size: req.file.size,
        filename: req.file.originalname,
        mimeType: req.file.mimetype
      }
    }
  }

  if (req.file?.buffer) {
    return {
      mode: 'buffer',
      input: {
        ...common,
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype
      }
    }
  }

  return {
    mode: 'dataUrl',
    input: {
      ...common,
      fileBase64: body.fileBase64 || body.file_base64 || body.dataUrl || body.content,
      filename: body.filename || body.fileName || body.originalFilename || 'archivo'
    }
  }
}

export async function uploadMediaHandler(req, res) {
  const directChat = req.directChatUpload || directChatCompatibilityFromRequest(req)
  let tempFileHandedOff = false
  try {
    logger.info('[MediaStorage] Subida iniciada')
    const context = trustedUploadContextFromRequest(req)
    const executeUpload = async () => {
      const prepared = await uploadInputFromRequest(req)
      // El storage es el único que puede entregar el temporal a un job diferido.
      // El controller lo borra al salir salvo que reciba explícitamente el handoff.
      prepared.input.onTempFileHandedOff = () => { tempFileHandedOff = true }
      return prepared.mode === 'buffer'
        ? uploadMediaAsset(prepared.input)
        : uploadMediaAssetFromDataUrl(prepared.input)
    }

    let asset
    if (context.clientUploadId) {
      const descriptors = [mediaUploadRequestDescriptor(req, context, directChat)]
      if (cleanString(context.clientAccountId)) {
        descriptors.push(mediaUploadRequestDescriptor(req, context, directChat, {
          includeClientAccount: false
        }))
      }
      const [requestHash, ...compatibleRequestHashes] = await createMediaUploadRequestHashes({
        descriptors,
        filePath: req.file?.path || '',
        buffer: req.file?.buffer,
        content: req.body?.fileBase64 || req.body?.file_base64 ||
          req.body?.dataUrl || req.body?.content || ''
      })
      asset = await runIdempotentMediaUpload({
        businessId: context.businessId,
        clientUploadId: context.clientUploadId,
        requestHash,
        compatibleRequestHashes,
        validateCompatibleReplay: cleanString(context.clientAccountId)
          ? (response, row) => compatibleReplayBelongsToAccount(
              response,
              row,
              context.clientAccountId
            )
          : null,
        create: executeUpload
      })
    } else {
      asset = await executeUpload()
    }
    res.status(201).json({ success: true, data: asset })
  } catch (error) {
    logger.error(`[MediaStorage] Error subiendo archivo: ${error.message}`)
    sendError(res, error, 'Error subiendo archivo multimedia')
  } finally {
    // Si mediaStorage entregó el archivo a Bunny Stream diferido, ese job es su
    // nuevo dueño. En cualquier otro caso el rm es seguro e idempotente, incluso
    // cuando esta petición solo reprodujo una respuesta del ledger.
    if (req.file?.path && !tempFileHandedOff) {
      await fs.rm(req.file.path, { force: true }).catch(() => undefined)
    }
  }
}

export async function listMediaAssetsHandler(req, res) {
  try {
    const hasFolderPath = Object.prototype.hasOwnProperty.call(req.query || {}, 'path') ||
      Object.prototype.hasOwnProperty.call(req.query || {}, 'folderPath') ||
      Object.prototype.hasOwnProperty.call(req.query || {}, 'folder_path')
    const page = await listMediaAssets({
      businessId: req.query.businessId || 'default',
      module: req.query.module || '',
      mediaType: req.query.mediaType || req.query.media_type || '',
      status: req.query.status || '',
      search: req.query.search || req.query.q || '',
      folderPath: hasFolderPath
        ? req.query.path ?? req.query.folderPath ?? req.query.folder_path ?? ''
        : null,
      recursive: parseBoolean(req.query.recursive),
      limit: req.query.limit,
      cursor: req.query.cursor || '',
      includeMeta: parseBoolean(req.query.includeMeta ?? req.query.include_meta, true),
      includeFolders: parseBoolean(req.query.includeFolders ?? req.query.include_folders, true)
    })
    res.json({ success: true, data: page })
  } catch (error) {
    sendError(res, error, 'Error listando archivos multimedia')
  }
}

export async function listMediaFoldersHandler(req, res) {
  try {
    const page = await listMediaFolders({
      businessId: req.query.businessId || 'default',
      parentPath: req.query.parentPath ?? req.query.parent_path ?? req.query.path ?? '',
      module: req.query.module || '',
      mediaType: req.query.mediaType || req.query.media_type || '',
      status: req.query.status || '',
      limit: req.query.limit,
      cursor: req.query.cursor || ''
    })
    res.json({ success: true, data: page })
  } catch (error) {
    sendError(res, error, 'Error listando carpetas multimedia')
  }
}

export async function createMediaFolderHandler(req, res) {
  try {
    const body = req.body || {}
    const folder = await createMediaFolder({
      businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
      parentPath: body.parentPath ?? body.parent_path ?? body.path ?? '',
      name: body.name || body.folderName || body.folder_name || '',
      userId: req.user?.userId || req.user?.id || null
    })
    res.status(201).json({ success: true, data: folder })
  } catch (error) {
    sendError(res, error, 'Error creando carpeta multimedia')
  }
}

export async function getMediaAssetUrlHandler(req, res) {
  try {
    const asset = await getMediaAsset(req.params.assetId)
    res.json({
      success: true,
      data: {
        id: asset.id,
        url: asset.publicUrl,
        publicUrl: asset.publicUrl,
        privateUrl: asset.privateUrl,
        status: asset.status,
        mimeType: asset.mimeType,
        mediaType: asset.mediaType
      }
    })
  } catch (error) {
    sendError(res, error, 'Error obteniendo URL multimedia')
  }
}

export async function getStorageUsageHandler(req, res) {
  try {
    const usage = await getStorageUsage({ businessId: req.query.businessId || 'default' })
    res.json({ success: true, data: usage })
  } catch (error) {
    sendError(res, error, 'Error calculando almacenamiento')
  }
}

export async function deleteMediaAssetHandler(req, res) {
  try {
    const result = await softDeleteMediaAsset(req.params.assetId)
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error eliminando archivo multimedia')
  }
}

export async function downloadMediaAssetHandler(req, res) {
  try {
    const { stream, contentType, contentLength, filename } = await getMediaAssetReadStream(req.params.assetId)
    const downloadName = safeHeaderFilename(filename || req.params.assetId, req.params.assetId)
    res.setHeader('Content-Type', contentType || 'application/octet-stream')
    if (contentLength > 0) res.setHeader('Content-Length', String(contentLength))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', attachmentDisposition(downloadName))
    await pipeline(stream, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    sendError(res, error, 'Error descargando archivo multimedia')
  }
}

export async function downloadMediaAssetsArchiveHandler(req, res) {
  try {
    const body = req.body || {}
    const requestedEntries = archiveEntriesFromBody(body)
    const requestedIds = Array.from(new Set([
      ...(Array.isArray(body.assetIds) ? body.assetIds : []),
      ...requestedEntries.map((entry) => entry.id)
    ].map(cleanString).filter(Boolean)))
    const folderPaths = Array.isArray(body.folderPaths) ? body.folderPaths : []
    if (!requestedIds.length && !folderPaths.length) {
      throw downloadInputError('Selecciona al menos un archivo para descargar.')
    }
    const pathOverrides = new Map(requestedEntries.map((entry) => [entry.id, entry.path]))
    const resolvedEntries = await resolveMediaAssetSelection({
      businessId: body.businessId || body.business_id || 'default',
      assetIds: requestedIds,
      folderPaths,
      mediaType: body.mediaType || body.media_type || '',
      status: body.status || '',
      maxItems: MAX_ARCHIVE_DOWNLOAD_ITEMS
    })
    const entries = resolvedEntries.map((entry) => ({
      ...entry,
      path: pathOverrides.get(entry.id) || entry.path
    }))
    if (!entries.length) {
      throw downloadInputError('No se encontraron archivos activos dentro de la selección.', 404, 'media_selection_empty')
    }
    if (entries.length > MAX_ARCHIVE_DOWNLOAD_ITEMS) {
      throw downloadInputError(`Selecciona máximo ${MAX_ARCHIVE_DOWNLOAD_ITEMS} archivos por descarga.`, 413, 'media_archive_too_large')
    }
    validateMediaArchiveEntries(entries)

    const zip = new JSZip()
    const usedPaths = new Set()
    const budget = { bytesRead: 0 }

    for (const entry of entries) {
      const fallbackName = safeHeaderFilename(entry.path || `${entry.id}.bin`, `${entry.id}.bin`)
      const archivePath = uniqueZipPath(sanitizeZipPath(entry.path, fallbackName), usedPaths)
      // El generador async abre un solo archivo cuando JSZip lo consume. No
      // dispara cientos de lecturas remotas horizontales ni conserva buffers
      // completos en memoria.
      zip.file(archivePath, lazyBoundedArchiveStream(entry, budget), { binary: true })
    }

    const archiveName = ensureZipFilename(req.body?.filename)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', attachmentDisposition(archiveName))
    const archiveStream = zip.generateNodeStream({
      type: 'nodebuffer',
      streamFiles: true,
      // Imágenes, audio y video ya llegan comprimidos. STORE evita quemar CPU
      // y permite empezar a entregar el ZIP desde el primer archivo.
      compression: 'STORE'
    })
    await pipeline(archiveStream, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    sendError(res, error, 'Error descargando archivos multimedia')
  }
}

export async function moveMediaAssetsHandler(req, res) {
  try {
    const body = req.body || {}
    const moved = await moveMediaAssets({
      businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
      entries: Array.isArray(body.entries) ? body.entries : [],
      assetIds: Array.isArray(body.assetIds) ? body.assetIds : [],
      targetFolderPath: body.targetFolderPath || body.folderPath || ''
    })
    res.json({ success: true, data: moved })
  } catch (error) {
    sendError(res, error, 'Error moviendo archivos multimedia')
  }
}

export async function moveMediaSelectionHandler(req, res) {
  try {
    const body = req.body || {}
    const result = await moveMediaSelection({
      businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
      assetIds: Array.isArray(body.assetIds) ? body.assetIds : [],
      folderPaths: Array.isArray(body.folderPaths) ? body.folderPaths : [],
      mediaType: body.mediaType || body.media_type || '',
      status: body.status || '',
      targetFolderPath: body.targetFolderPath || body.folderPath || ''
    })
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error moviendo la selección multimedia')
  }
}

export async function deleteMediaSelectionHandler(req, res) {
  try {
    const body = req.body || {}
    const result = await deleteMediaSelection({
      businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
      assetIds: Array.isArray(body.assetIds) ? body.assetIds : [],
      folderPaths: Array.isArray(body.folderPaths) ? body.folderPaths : [],
      mediaType: body.mediaType || body.media_type || '',
      status: body.status || ''
    })
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error eliminando la selección multimedia')
  }
}

export async function replaceMediaAssetHandler(req, res) {
  let tempFileHandedOff = false
  try {
    const prepared = await uploadInputFromRequest(req)
    prepared.input.onTempFileHandedOff = () => { tempFileHandedOff = true }
    const result = prepared.mode === 'buffer'
      ? await replaceMediaAsset(req.params.assetId, prepared.input)
      : await replaceMediaAsset(req.params.assetId, {
          ...prepared.input,
          buffer: undefined,
          fileBase64: prepared.input.fileBase64
        })
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error reemplazando archivo multimedia')
  } finally {
    if (req.file?.path && !tempFileHandedOff) {
      await fs.rm(req.file.path, { force: true }).catch(() => undefined)
    }
  }
}

export async function retryMediaAssetHandler(req, res) {
  try {
    const result = await retryMediaAsset(req.params.assetId)
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error reintentando archivo multimedia')
  }
}

export async function syncMediaAssetStreamHandler(req, res) {
  try {
    const body = req.body || {}
    const asset = await syncMediaAssetBunnyStream(req.params.assetId, {
      module: body.module || req.query?.module,
      moduleEntityId: body.moduleEntityId || body.module_entity_id || req.query?.moduleEntityId || req.query?.module_entity_id
    })
    res.json({ success: true, data: asset })
  } catch (error) {
    sendError(res, error, 'Error sincronizando metadata de Bunny Stream')
  }
}

export async function getMediaAssetStreamAnalyticsHandler(req, res) {
  try {
    const analytics = await getMediaAssetBunnyStreamAnalytics(req.params.assetId, {
      dateFrom: req.query.dateFrom || req.query.date_from,
      dateTo: req.query.dateTo || req.query.date_to,
      hourly: parseBoolean(req.query.hourly)
    })
    res.json({ success: true, data: analytics })
  } catch (error) {
    sendError(res, error, 'Error obteniendo analíticas de Bunny Stream')
  }
}

export async function storageDiagnosticsHandler(_req, res) {
  try {
    const diagnostics = await runStorageDiagnostics()
    res.json({ success: true, data: diagnostics })
  } catch (error) {
    sendError(res, error, 'Error diagnosticando almacenamiento')
  }
}

export async function serveMediaAssetFileHandler(req, res) {
  try {
    const assetId = req.params.assetId || extractMediaAssetIdFromUrl(req.originalUrl)
    if (parseBoolean(req.query?.voice, false) || req.params.variant === 'voice') {
      const asset = await getMediaAsset(assetId)
      const assetSize = Number(asset?.sizeProcessed || asset?.sizeOriginal || 0)
      if (asset?.mediaType !== 'audio') {
        const error = new Error('El asset solicitado no es audio.')
        error.status = 400
        error.code = 'invalid_voice_asset'
        throw error
      }
      if (assetSize > 16 * 1024 * 1024) {
        const error = new Error('La nota de voz supera el límite de 16 MB de WhatsApp.')
        error.status = 413
        error.code = 'voice_asset_too_large'
        throw error
      }
      const file = await getMediaAssetBuffer(assetId)
      if (file.buffer.length > 16 * 1024 * 1024) {
        const error = new Error('La nota de voz supera el límite de 16 MB de WhatsApp.')
        error.status = 413
        error.code = 'voice_asset_too_large'
        throw error
      }
      if (!isValidWhatsAppVoiceNoteBuffer(file.buffer)) {
        const error = new Error('El archivo no es una nota de voz OGG/Opus válida.')
        error.status = 415
        throw error
      }
      // Meta documenta el tipo admitido como `audio/ogg` y valida el codec
      // inspeccionando los bytes. Enviar el parametro `codecs=opus` en el
      // header HTTP hace que su fetcher asincrono reclasifique un OGG valido
      // como application/octet-stream (131053), aunque Baileys si use ese MIME
      // completo dentro del mensaje. El proxy publico debe usar el MIME base.
      res.setHeader('Content-Type', 'audio/ogg')
      res.setHeader('Content-Length', String(file.buffer.length))
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Disposition', `inline; filename="${voiceNoteTransportFilename(assetId)}"`)
      res.send(file.buffer)
      return
    }
    const file = await getMediaAssetFile(assetId, req.params.variant || '')
    if (file.redirectUrl) {
      return res.redirect(302, file.redirectUrl)
    }

    res.setHeader('Content-Type', file.contentType || 'application/octet-stream')
    if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength))
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    // (SEC-010) Evitar XSS almacenado vía media servida desde nuestro dominio: nunca dejar
    // que el navegador "adivine" el tipo (nosniff) y solo servir INLINE los tipos seguros de
    // visualización (imágenes raster, video, audio, PDF). Tipos ejecutables (SVG, HTML, XML,
    // JS...) se fuerzan a DESCARGA (attachment) para que no corran scripts en el origen.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const contentTypeLower = String(file.contentType || '').toLowerCase()
    const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/|audio\/|application\/pdf)\b/.test(contentTypeLower)
    if (file.filename) {
      const disposition = inlineSafe ? 'inline' : 'attachment'
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.filename)}"`)
    }
    file.stream.pipe(res)
  } catch (error) {
    res.status(error.status || 404).json({ success: false, error: error.message })
  }
}

export async function internalStorageUsageHandler(_req, res) {
  try {
    const usage = await getStorageUsage({ businessId: 'default' })
    res.json(usage)
  } catch (error) {
    sendError(res, error, 'Error calculando almacenamiento interno')
  }
}

export async function internalStorageDiagnosticsHandler(_req, res) {
  try {
    const diagnostics = await runStorageDiagnostics()
    res.json(diagnostics)
  } catch (error) {
    sendError(res, error, 'Error diagnosticando almacenamiento interno')
  }
}
