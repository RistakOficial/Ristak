import { db } from '../config/database.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { hasFeature } from './licenseService.js'
import { resolveOutboundChatMediaReference } from './outboundMediaReferenceService.js'

// Igual que el límite del documento binario en whatsappApiService.
const MAX_PRIVATE_DOCUMENT_BYTES = 20 * 1024 * 1024

function referenceError(message, status, code) {
  return Object.assign(new Error(message), { status, statusCode: status, code })
}

function tooLarge() {
  return referenceError('El documento pesa demasiado. Elige uno de menos de 20 MB para poder enviarlo por WhatsApp.', 413, 'media_download_too_large')
}

/**
 * Los documentos privados nunca salen como enlace: sólo un usuario con lectura
 * de Media puede entregarlos al proveedor por bytes dentro de su instalación.
 * Las referencias públicas conservan las validaciones estrictas de Chat.
 */
export async function resolveOutboundWhatsAppDocumentReference({
  mediaAssetId = '', businessId = '', user = null, licenseState = null, ...publicOptions
} = {}) {
  const assetId = String(mediaAssetId || '').trim()
  const tenant = String(businessId || process.env.RISTAK_BUSINESS_ID || 'default')
    .trim().replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'default'
  const asset = assetId ? await db.get(
    `SELECT id, module, status, deleted_at, is_public, media_type, mime_type,
            original_filename, size_processed
     FROM media_assets WHERE business_id = ? AND id = ? LIMIT 1`,
    [tenant, assetId]
  ) : null

  if (!asset || Number(asset.is_public) !== 0) {
    return resolveOutboundChatMediaReference({ ...publicOptions, mediaAssetId: assetId, businessId: tenant, user, licenseState })
  }
  if (asset.deleted_at || asset.status !== 'ready' || !['media', 'chat'].includes(asset.module)) {
    throw referenceError('El archivo ya no está disponible para enviarse desde este chat.', 404, 'chat_media_asset_unavailable')
  }
  if (asset.media_type !== 'document') {
    throw referenceError('El archivo no coincide con el tipo de mensaje que intentas enviar.', 409, 'chat_media_asset_type_mismatch')
  }
  if (!(user?.id || user?.userId) || !hasUserAccess(user, 'settings_media', 'read') ||
      !(await hasFeature('settings_media', { state: licenseState, email: user?.email || user?.username }))) {
    throw referenceError('Necesitas acceso de lectura a Media para enviar este documento privado.', 403, 'private_media_read_access_required')
  }
  if (Number(asset.size_processed) > MAX_PRIVATE_DOCUMENT_BYTES) throw tooLarge()

  // Importación diferida: Storage utiliza las validaciones HTTPS de referencias.
  const { getMediaAssetDownloadFile } = await import('./mediaStorageService.js')
  const file = await getMediaAssetDownloadFile(asset.id)
  try {
    if (Number(file.contentLength) > MAX_PRIVATE_DOCUMENT_BYTES) throw tooLarge()
    const chunks = []
    let length = 0
    for await (const chunk of file.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > MAX_PRIVATE_DOCUMENT_BYTES) throw tooLarge()
      chunks.push(bytes)
    }
    if (!length || (Number.isSafeInteger(file.contentLength) && length !== file.contentLength)) {
      throw referenceError('No se pudo leer completo el documento privado.', 502, 'private_media_download_incomplete')
    }
    return {
      url: '', mediaAssetId: asset.id, mimeType: asset.mime_type,
      filename: asset.original_filename, mediaType: 'document',
      documentDataUrl: `data:${asset.mime_type};base64,${Buffer.concat(chunks, length).toString('base64')}`,
      sensitive: true, source: 'private_media_asset'
    }
  } finally {
    file.stream?.destroy?.()
    file.cleanup?.()
  }
}
